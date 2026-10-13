import { Boxes, Calendar, ChartColumn, Database, FileText, Folder, House, LayoutDashboard, LayoutGrid, Mail, Megaphone, Settings, ShieldCheck, Users, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { IconName } from "../../server/nav";

const ICONS: Record<IconName, LucideIcon> = {
  app: Boxes,
  home: House,
  apps: LayoutGrid,
  settings: Settings,
  dashboard: LayoutDashboard,
  documents: FileText,
  chart: ChartColumn,
  megaphone: Megaphone,
  users: Users,
  database: Database,
  mail: Mail,
  calendar: Calendar,
  folder: Folder,
  shield: ShieldCheck,
  bolt: Zap,
};

export function NavIcon({ name, className }: { name: IconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden className={className ?? "size-4"} strokeWidth={1.75} />;
}
