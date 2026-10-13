import { appearanceCss, readAppearance, themeInitScript } from "@epnexo/core/settings";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { platform } from "../server/platform";

/**
 * Puts the saved appearance into the page: the token overrides as a stylesheet, and the script that picks the
 * theme before the first paint. Everything in the stylesheet comes from a closed set of values (see
 * `appearanceCss`), so nothing a user typed reaches it as text.
 */
export async function AppearanceHead() {
  const state = await readAppearance(platform().pool);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: appearanceCss(state) }} />
      <script dangerouslySetInnerHTML={{ __html: themeInitScript(state.platform.theme, THEME_STORAGE_KEY) }} />
    </>
  );
}
