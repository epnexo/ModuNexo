import { type NavGroup, resolveIcon } from "../../server/nav";
import { NavIcon } from "./icon";
import { AdminNav } from "./admin-nav";
import { NavLink } from "./nav-link";

/**
 * The dashboard, then one block per module group, and at the bottom the Admin block, which only an administrator is
 * given. Rendered on the server; only the links and the Admin block are client.
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
      {groups.map((group) => (
        <div key={group.label ?? "ungrouped"} className="flex flex-col gap-1">
          {group.label === null ? null : <h2 className="px-2.5 text-xs font-medium text-muted">{group.label}</h2>}
          <ul className="flex flex-col gap-0.5">
            {group.entries.map((entry) => (
              <li key={`${entry.moduleId}:${entry.href}`}>
                <NavLink href={entry.href}>
                  <NavIcon name={resolveIcon(entry.icon)} />
                  {entry.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {admin ? <AdminNav /> : null}
    </nav>
  );
}
