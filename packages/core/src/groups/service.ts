import type pg from "pg";

/** Held while groups are written, so two requests at the same moment cannot take the same position. */
const GROUPS_LOCK = 7_302_203;
export const MAX_GROUP_NAME = 40;

export type GroupErrorCode = "invalid-name" | "duplicate" | "not-found" | "module-not-installed";

/** A group request the platform refuses. The message is safe to show to the person who asked. */
export class GroupError extends Error {
  constructor(
    readonly code: GroupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GroupError";
  }
}

export interface Group {
  id: number;
  name: string;
  /** 0-based and contiguous: the order the sidebar shows the groups in. */
  position: number;
  /** Installed modules sitting in the group. */
  moduleCount: number;
}

export interface GroupOverview {
  groups: Group[];
  /** Module id to group id, for the modules that have one. */
  assignments: Record<string, number>;
}

const UNIQUE_VIOLATION = "23505";

function cleanName(raw: string): string {
  const name = raw.trim();
  // Postgres counts characters, not UTF-16 units, and cannot store a NUL.
  if (name === "" || [...name].length > MAX_GROUP_NAME || name.includes("\u0000")) {
    throw new GroupError("invalid-name", `A group name has 1 to ${MAX_GROUP_NAME} characters.`);
  }
  return name;
}

const duplicate = (name: string) => new GroupError("duplicate", `There is already a group called "${name}".`);
const missing = () => new GroupError("not-found", "That group does not exist.");

/** The groups of the sidebar menu and the group each installed module sits in. */
export class GroupService {
  constructor(private readonly pool: pg.Pool) {}

  /** Runs `work` in a transaction that holds the groups lock. */
  async #write<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [GROUPS_LOCK]);
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  async list(): Promise<Group[]> {
    return (await this.overview()).groups;
  }

  async overview(): Promise<GroupOverview> {
    const groups = await this.pool.query(
      `select g.id, g.name, g.position, count(m.id)::int as module_count
       from core.module_groups g left join core.modules m on m.group_id = g.id
       group by g.id order by g.position, g.id`,
    );
    const assigned = await this.pool.query("select id, group_id from core.modules where group_id is not null");
    return {
      groups: groups.rows.map((row) => ({ id: Number(row.id), name: row.name, position: row.position, moduleCount: row.module_count })),
      assignments: Object.fromEntries(assigned.rows.map((row) => [row.id as string, Number(row.group_id)])),
    };
  }

  /** A new group goes last. */
  async create(rawName: string): Promise<Group> {
    const name = cleanName(rawName);
    return this.#write(async (client) => {
      try {
        const { rows } = await client.query(
          "insert into core.module_groups (name, position) values ($1, (select coalesce(max(position) + 1, 0) from core.module_groups)) returning id, position",
          [name],
        );
        return { id: Number(rows[0].id), name, position: rows[0].position, moduleCount: 0 };
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw duplicate(name);
        throw error;
      }
    });
  }

  async rename(id: number, rawName: string): Promise<Group> {
    const name = cleanName(rawName);
    return this.#write(async (client) => {
      try {
        const { rowCount } = await client.query("update core.module_groups set name = $2 where id = $1", [id, name]);
        if (rowCount === 0) throw missing();
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw duplicate(name);
        throw error;
      }
      return this.#one(client, id);
    });
  }

  /** Puts the group at `position` (0-based; out of range is clamped) and renumbers the rest. */
  async move(id: number, position: number): Promise<Group[]> {
    return this.#write(async (client) => {
      const { rows } = await client.query("select id from core.module_groups order by position, id");
      const ids = rows.map((row) => Number(row.id));
      const from = ids.indexOf(id);
      if (from === -1) throw missing();
      ids.splice(from, 1);
      ids.splice(Math.min(Math.max(Math.trunc(position), 0), ids.length), 0, id);
      await this.#renumber(client, ids);
      return (await this.#groups(client));
    });
  }

  /** Its modules stay installed and have no group again. */
  async remove(id: number): Promise<void> {
    await this.#write(async (client) => {
      const { rowCount } = await client.query("delete from core.module_groups where id = $1", [id]);
      if (rowCount === 0) throw missing();
      const { rows } = await client.query("select id from core.module_groups order by position, id");
      await this.#renumber(client, rows.map((row) => Number(row.id)));
    });
  }

  /** Puts an installed module in a group, or takes it out of its group with `null`. */
  async assign(moduleId: string, groupId: number | null): Promise<void> {
    await this.#write(async (client) => {
      if (groupId !== null && (await client.query("select 1 from core.module_groups where id = $1", [groupId])).rowCount === 0) throw missing();
      const { rowCount } = await client.query("update core.modules set group_id = $2 where id = $1", [moduleId, groupId]);
      if (rowCount === 0) throw new GroupError("module-not-installed", `Module "${moduleId}" is not installed.`);
    });
  }

  async #renumber(client: pg.PoolClient, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await client.query(
      "update core.module_groups g set position = o.position from (select id, (ord - 1)::int as position from unnest($1::bigint[]) with ordinality as t(id, ord)) o where g.id = o.id",
      [ids],
    );
  }

  async #groups(client: pg.PoolClient): Promise<Group[]> {
    const { rows } = await client.query(
      `select g.id, g.name, g.position, count(m.id)::int as module_count
       from core.module_groups g left join core.modules m on m.group_id = g.id group by g.id order by g.position, g.id`,
    );
    return rows.map((row) => ({ id: Number(row.id), name: row.name, position: row.position, moduleCount: row.module_count }));
  }

  async #one(client: pg.PoolClient, id: number): Promise<Group> {
    const found = (await this.#groups(client)).find((group) => group.id === id);
    if (found === undefined) throw missing();
    return found;
  }
}
