export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export const errorPage = (status: number, message: string): Response =>
  page(status, "Error", `<h1>Error</h1><p>${escapeHtml(message)}</p>`);

export const refusalPage = (): Response =>
  page(403, "Access refused", "<h1>Access refused</h1><p>This account is not invited.</p>");
