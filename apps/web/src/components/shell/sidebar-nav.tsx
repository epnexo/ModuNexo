import { type IconName, type NavGroup, resolveIcon } from "../../server/nav";
import { NavIcon } from "./icon";
import { NavLink } from "./nav-link";

const SHELL_ENTRIES: { label: string; href: string; icon: IconName }[] = [
  { label: "Home", href: "/", icon: "home" },
  { label: "Apps", href: "/apps", icon: "apps" },
  { label: "Settings", href: "/settings", icon: "settings" },
];

/** The shell's own entries, then one block per module group. Rendered on the server; only the links are client. */
export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-6">
      <ul className="flex flex-col gap-0.5">
        {SHELL_ENTRIES.map((entry) => (
          <li key={entry.href}>
            <NavLink href={entry.href}>
              <NavIcon name={entry.icon} />
              {entry.label}
            </NavLink>
          </li>
        ))}
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
    </nav>
  );
}
