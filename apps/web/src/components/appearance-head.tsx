import { appearanceCss, readAppearance, readServedCustomCss, readServedUserCss, themeInitScript } from "@modunexo/core/settings";
import { cookies } from "next/headers";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { platform } from "../server/platform";
import { SAFE_MODE_COOKIE } from "../server/safe-mode";

/**
 * Puts the saved appearance into the page: the token overrides as a stylesheet, and the script that picks the
 * theme before the first paint. Everything in the stylesheet comes from a closed set of values (see
 * `appearanceCss`), so nothing a user typed reaches it as text. The company's custom CSS comes after it, in its own
 * element, only as `readServedCustomCss` rewrote it (parsed and written again from the rules that pass, never the text as
 * typed), and not at all in safe mode (`?nocss=1`). The signed-in person's own stylesheet follows it, after it in the cascade;
 * the page that already knows who is asking passes `userId`, so this asks nothing more about the session.
 */
export async function AppearanceHead({ userId = null }: { userId?: string | null } = {}) {
  const pool = platform().pool;
  const safeMode = (await cookies()).get(SAFE_MODE_COOKIE)?.value === "1";
  const [state, custom, own] = await Promise.all([
    readAppearance(pool),
    safeMode ? Promise.resolve("") : readServedCustomCss(pool),
    safeMode ? Promise.resolve("") : readServedUserCss(pool, userId),
  ]);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: appearanceCss(state) }} />
      {custom === "" ? null : <style data-custom dangerouslySetInnerHTML={{ __html: custom }} />}
      {own === "" ? null : <style data-person dangerouslySetInnerHTML={{ __html: own }} />}
      <script dangerouslySetInnerHTML={{ __html: themeInitScript(state.platform.theme, THEME_STORAGE_KEY) }} />
    </>
  );
}
