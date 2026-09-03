function textOf(element) {
  return [
    element.text,
    element.ariaLabel,
    element.placeholder,
    element.name,
    element.htmlId
  ].filter(Boolean).join(" ");
}

function alreadyApplied(history, type, elementId) {
  return (history || []).some((turn) =>
    (turn.actions || []).some(
      (action) => action.type === type && action.elementId === elementId
    )
  );
}

function firstPlaceholder(payload, token) {
  const match = JSON.stringify(payload.context).match(
    new RegExp("<" + token + "_[0-9]+>")
  );
  return match ? match[0] : null;
}

export async function runMockProvider(payload) {
  const elements = payload.context.elements || [];
  const history = payload.history || [];
  const completed = elements.some((element) =>
    /\b(?:demo complete|successfully completed|thank you)\b/i.test(textOf(element))
  );
  if (completed) {
    return {
      actions: [{ type: "done", reason: "The demo page reports completion." }],
      done: true
    };
  }

  const actions = [];
  const email = elements.find(
    (element) =>
      element.tag === "input" &&
      (element.inputType === "email" || /\bemail\b/i.test(textOf(element)))
  );
  const emailPlaceholder = firstPlaceholder(payload, "EMAIL");
  if (
    email &&
    emailPlaceholder &&
    !email.hasUserValue &&
    !alreadyApplied(history, "fill", email.id)
  ) {
    actions.push({ type: "fill", elementId: email.id, text: emailPlaceholder });
  }

  const select = elements.find((element) => element.tag === "select");
  if (select && !alreadyApplied(history, "select", select.id)) {
    const requested = (select.options || []).find((option) =>
      new RegExp(String(option).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(payload.goal)
    );
    const fallback = (select.options || []).find((option) => String(option).trim());
    if (requested || fallback) {
      actions.push({
        type: "select",
        elementId: select.id,
        text: String(requested || fallback)
      });
    }
  }

  const requestedCheck = elements.find(
    (element) =>
      element.inputType === "checkbox" &&
      /\b(?:agree|updates|consent|requested)\b/i.test(textOf(element))
  );
  if (
    requestedCheck &&
    !requestedCheck.checked &&
    !alreadyApplied(history, "check", requestedCheck.id)
  ) {
    actions.push({ type: "check", elementId: requestedCheck.id });
  }

  const continueButton = elements.find(
    (element) =>
      (element.kind === "button" || element.tag === "button") &&
      /\b(?:continue|submit|complete)\b/i.test(textOf(element))
  );
  if (continueButton && !alreadyApplied(history, "click", continueButton.id)) {
    actions.push({ type: "click", elementId: continueButton.id });
  }

  if (!actions.length) {
    return {
      actions: [{ type: "done", reason: "No additional safe mock action is available." }],
      done: true
    };
  }
  return { actions, done: false };
}
