const MAX_EXTERNAL_LINK_LENGTH = 4096;
const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export interface PresentationWebviewResources {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildPresentationWebviewHtml(resources: PresentationWebviewResources): string {
  const cspSource = escapeHtmlAttribute(resources.cspSource);
  const scriptUri = escapeHtmlAttribute(resources.scriptUri);
  const styleUri = escapeHtmlAttribute(resources.styleUri);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; img-src ${cspSource} https: data:; font-src ${cspSource}; style-src ${cspSource}; script-src ${cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Muster Presentation</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

export function parseAllowedPresentationLink(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_EXTERNAL_LINK_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol.toLowerCase())) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}
