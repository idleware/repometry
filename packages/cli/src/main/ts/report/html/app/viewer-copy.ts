import { element, svgElement } from './viewer-dom.js';

interface CopyFeedback {
  /** The text is on the clipboard; the button shows its check until `reset`. */
  copied(): void;
  reset(): void;
  /** The browser refused the clipboard: the reader copies by hand. */
  refused(): void;
}

/** Copies the text on each click, with a check that fades after a moment, or the fallback the browser leaves. */
export function copyOnClick(button: HTMLButtonElement, text: () => string, feedback: CopyFeedback): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', async () => {
    clearTimeout(timer);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text());
      button.classList.add('fx-copied');
      feedback.copied();
      timer = setTimeout(() => {
        button.classList.remove('fx-copied');
        feedback.reset();
      }, 1500);
    } catch {
      feedback.refused();
    }
  });
}

/**
 * Copies a file's path from the repository root. Where the browser refuses the clipboard, `show` puts the path on the
 * page and it is selected, for the reader's own copy shortcut.
 */
export function copyPathButton(path: string, show: () => HTMLElement): HTMLButtonElement {
  const label = 'Copy path';
  const copy = element('button', 'fx-copy fx-copy-inline');
  copy.type = 'button';
  copy.title = `${label}: ${path}`;
  copy.setAttribute('aria-label', label);
  copy.append(copyIcon());
  const status = element('span', 'visually-hidden');
  status.setAttribute('role', 'status');
  copy.append(status);
  copyOnClick(copy, () => path, {
    copied: () => { status.textContent = 'Path copied'; },
    reset: () => { status.textContent = ''; },
    refused: () => {
      window.getSelection()?.selectAllChildren(show());
      status.textContent = 'Path selected. Press your copy shortcut.';
    },
  });
  return copy;
}

/** The common copy glyph, two offset sheets, with the check it turns into once copied. */
export function copyIcon(): SVGSVGElement {
  const svg = svgElement('svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    ['rect', { class: 'fx-copy-sheets', x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5' }],
    ['path', { class: 'fx-copy-sheets', d: 'M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5' }],
    ['path', { class: 'fx-copy-check', d: 'M3 8.5l3 3 7-7' }],
  ];
  for (const [tag, attributes] of shapes) {
    const shape = svgElement(tag as 'path');
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}
