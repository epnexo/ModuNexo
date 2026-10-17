# Brand profile: business or personal identity for the shell (stage P1)

Objective: in Settings the administrator says whether this platform is for a business or for a person, and the shell
presents itself with that identity instead of the hardcoded "epnexo".
Branch `feat/brand-profile`, stacked on `feat/apps-lifecycle` (head `e9d02bd`). Delivery strategy `auto-chain`;
no remote. Test runner: `npm test`, `npm run typecheck`. Test-first where a runnable test exists.

## Specs

Quoted fragments are the owner's words; the rest is the plan, assumptions marked.

- **S1 Kind.** "si es para bussiness o personal". Settings has a Profile section where the administrator picks
  `business` or `personal`. Until one is chosen the shell keeps its current "epnexo" look.
- **S2 Business.** "si es empresas solicitar el logo representatnte coreo web y demas que sea necesario".
  Fields: trade name (required), legal representative (required), contact email (required), logo, website, phone,
  tax id, address. Assumption: logo is optional for saving but the screen asks for it; the others after the three
  required are optional.
- **S3 Use as presentation.** "el logo remplaza el epnexo actalmente hardcodeado el pie de pagina y demas lables o
  info para que se vea profesional". The logo and name replace "epnexo" in the sidebar, mobile top bar, login page
  and page titles; a footer shows name, website and contact email.
- **S4 Personal.** "si es persona mucho mas sencillo con opcion de colocar una imagen o crear una interfas
  profesional para este caso y amigable". Fields: display name (required), optional photo. Without a photo the shell
  shows a generated monogram (initials on a color the person picks). Assumption: "crear una interfaz" means this
  generated avatar.
- **S5 Logo and photo files.** Assumption: PNG, JPEG or WebP only, at most 512 KB, content checked by its bytes not
  its name; SVG refused (it can carry script). Stored in the database; served by a public, cacheable route so the
  login page can show it.
- **S6 Admin only.** Only an administrator reads or changes the profile; the logo route is public read-only.
- **S7 Audit and docs.** Changes are recorded in `core.settings_events`; the README describes the feature.

- **S8 Set once.** Owner (L2): the CRM is for a business or a person, not both, chosen in an initial setup and then
  fixed. On the first visit of an administrator with no profile the shell shows a setup page and nothing else.
  Afterwards Settings edits the details but the kind is shown locked; the server refuses a change of kind (409).
- **S9 Deliberate reset.** Changing the kind is a separate "Reset identity" action in a danger zone: it needs the
  current name typed back, removes only the profile and the logo (never CRM data) and brings the setup page back.

## Tasks

- T1  (commit pending)
- T2 
- T3 
- T4 
- T5 
- T6 
- T7 

## Log

- L1 (2026-10-17) owner: "como base quiero generar en los settings realizar la configuracion si es para bussiness o personal
  si es empresas solicitar el logo representatnte coreo web y demas que sea necesario y utilizarlo como base de presentacion ejemplo
  el logo remplaza el epnexo actalmente hardcodeado el pie de pagina y demas lables o info para que se vea profesional
  si es persona mucho mas sencillo con opcion de colocar una imagen o crear una interfas profesional para este caso y amigable"
- Route: all inline (no writer trigger: tasks are sequential and share files). Risk: touches the proxy's public paths
  (item 2, security) in T2/T4.
- L2 (2026-10-17) owner: "no solo un crm sea de empresas o personal como se creo paresiera que se puede selecionar y despues cambiar
  cual seria la mejor forma yo sugiero es hacer  una configuracion inicial y hay dejarlo fijo o buscar una forma profesional para hacerlo"
  then, to my proposal (initial setup, kind fixed, deliberate reset with typed confirmation): "si me parese bien"
