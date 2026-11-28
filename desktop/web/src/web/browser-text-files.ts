// Browser text file picking shared by Web Edition file flows (downloads go through platform/file-delivery.ts).

export interface BrowserPickedTextFile {
  readonly fileName: string;
  readonly text: string;
}

/** Opens the browser file picker; resolves null when the user cancels. */
export async function pickBrowserTextFile(accept: string): Promise<BrowserPickedTextFile | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = false;
  input.style.display = "none";
  document.body.appendChild(input);

  try {
    return await new Promise<BrowserPickedTextFile | null>((resolve, reject) => {
      let settled = false;
      const finish = (value: BrowserPickedTextFile | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      input.addEventListener("change", () => {
        const file = input.files?.[0] ?? null;
        if (!file) {
          finish(null);
          return;
        }
        file.text()
          .then((text) => finish({ fileName: file.name, text }))
          .catch(fail);
      }, { once: true });
      input.addEventListener("cancel", () => finish(null), { once: true });
      input.click();
    });
  } finally {
    input.remove();
  }
}
