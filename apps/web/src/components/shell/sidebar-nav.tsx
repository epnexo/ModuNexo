import { type NavGroup, resolveIcon } from "../../server/nav";
import { NavIcon } from "./icon";
import { AdminNav } from "./admin-nav";
import { GroupNav } from "./group-nav";
import { NavLink } from "./nav-link";

/**
 * The dashboard, then one block per module group, and at the bottom the Admin block, which only an administrator is
 * given. The titled blocks open and close like Admin. Rendered on the server; the links and the blocks are client.
 */
export function SidebarNav({ groups, admin }: { groups: NavGroup[]; admin: boolean }) {
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-6">
      <ul className="flex flex-col gap-0.5">
        <li>
          <NavLink href="/">
            <NavIcon name="dashboard" />
            Dashboard
          </NavLink>
        </li>
      </ul>
      {groups.map((group) =>
        group.label === null ? (
          <ul key="ungrouped" className="flex flex-col gap-0.5">
            {group.entries.map((entry) => (
              <li key={`${entry.moduleId}:${entry.href}`}>
                <NavLink href={entry.href}>
                  <NavIcon name={resolveIcon(entry.icon)} />
                  {entry.label}
                </NavLink>
              </li>
            ))}
          </ul>
        ) : (
          <GroupNav key={group.label} group={{ ...group, label: group.label }} />
        ),
      )}
      {admin ? <AdminNav /> : null}
    </nav>
  );
}
