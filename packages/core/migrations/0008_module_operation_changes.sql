-- A run is no longer only the install or upgrade of a package: enabling, disabling and uninstalling a module
-- also rebuild the web app and are recorded the same way. Those have no package, so the SHA-256 is optional
-- exactly for them.

alter table core.module_operations drop constraint module_operations_kind_check;
alter table core.module_operations add constraint module_operations_kind_check
  check (kind in ('install', 'upgrade', 'enable', 'disable', 'uninstall'));

alter table core.module_operations alter column sha256 drop not null;
alter table core.module_operations add constraint module_operations_package_check
  check ((kind in ('install', 'upgrade')) = (sha256 is not null));
