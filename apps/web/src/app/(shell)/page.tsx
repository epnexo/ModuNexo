import { modules } from "../../generated/modules";
import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
      {modules.length === 0 ? (
        <p className="text-muted">
          No modules are installed yet. Modules add pages to this sidebar; install the first one from the{" "}
          <Link className="font-medium text-accent underline-offset-4 hover:underline" href="/apps">
            Apps
          </Link>{" "}
          screen.
        </p>
      ) : (
        <p className="text-muted">
          {modules.length} {modules.length === 1 ? "module is" : "modules are"} enabled. Open one from the sidebar.
        </p>
      )}
    </div>
  );
}
