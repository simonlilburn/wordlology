// The bundled typefaces (global.css imports them) and a promise that settles
// once they are loaded, so canvas text (the glyph atlas, card faces and
// thumbnails) is drawn with them rather than a fallback. Never waits longer
// than `timeoutMs`: a slow font must not hold up the picture.

export const DISPLAY = "'Bricolage Grotesque Variable', 'Arial Narrow', system-ui, sans-serif";
export const BODY = "'Atkinson Hyperlegible Next Variable', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
export const MONO = "'Martian Mono Variable', ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";

let ready: Promise<void> | null = null;

export function fontsReady(timeoutMs = 2500): Promise<void> {
  if (ready) return ready;
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return (ready = Promise.resolve());
  const loads = Promise.all([
    fonts.load(`800 16px ${DISPLAY}`),
    fonts.load(`400 16px ${BODY}`),
    fonts.load(`600 16px ${MONO}`),
  ]).then(
    () => undefined,
    () => undefined,
  );
  const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  ready = Promise.race([loads, timer]);
  return ready;
}
