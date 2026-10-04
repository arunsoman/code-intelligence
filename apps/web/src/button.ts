// Button feedback convention. Hover and pressed are pure CSS (`:hover`/`:active` in styles.css) and need no
// markup, so they work for every button in the app. A button that starts slow work additionally enters a
// pending state: the visible label is unchanged (so the layout does not jump), the state is announced with
// aria-busy, and a spinner — not a faded label on its own — shows it. `buttonFeedback` is the one place that
// decides the class and attribute so the components cannot drift apart, and it is unit-tested without a browser.
export interface ButtonFeedback {
  className: string | undefined;
  "aria-busy": "true" | undefined;
  spinner: boolean;
}

export function buttonFeedback(o: { className?: string; busy?: boolean }): ButtonFeedback {
  const className = [o.className, o.busy ? "pending" : ""].filter(Boolean).join(" ") || undefined;
  return { className, "aria-busy": o.busy ? "true" : undefined, spinner: !!o.busy };
}
