// A phone on its side: the page runs edge to edge, through the Dynamic Island's side too.
// Upright, iOS keeps its own edges, which fit.

const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
const base = viewport?.content.replace(/,\s*viewport-fit=cover/, "") ?? "";

function fit() {
  const sideways = innerWidth > innerHeight && matchMedia("(pointer: coarse)").matches;
  viewport?.setAttribute("content", sideways ? `${base}, viewport-fit=cover` : base);
}

export function fitEdges() {
  fit();
  addEventListener("resize", fit);
  addEventListener("orientationchange", fit);
}
