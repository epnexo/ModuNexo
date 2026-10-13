import { platform } from "../../../../server/platform.ts";

// The platform's authentication endpoints. Created lazily: see platform().
const handle = (request: Request) => platform().auth.handler(request);

export { handle as GET, handle as POST };
