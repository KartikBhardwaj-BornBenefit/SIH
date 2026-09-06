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

function firstProfileToken(payload, category) {
  return payload.profile && payload.profile.tokens && payload.profile.tokens[category]
    ? payload.profile.tokens[category]
    : null;
}

export async function runMockProvider(payload) {
  const elements = payload.context.elements || [];
  const history = payload.history || [];
  const authGate = payload.context.page && payload.context.page.authGate;
  if (authGate && authGate.blocking) {
    return {
      actions: [{ type: "wait", ms: 400 }],
      done: false
    };
  }
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
  const emailPlaceholder = firstPlaceholder(payload, "EMAIL") || firstProfileToken(payload, "email");
  if (
    email &&
    emailPlaceholder &&
    !email.hasUserValue &&
    !alreadyApplied(history, "fill", email.id)
  ) {
    actions.push({ type: "fill", elementId: email.id, text: emailPlaceholder });
  }

  const aadhaar = elements.find(
    (element) =>
      element.tag === "input" &&
      ((element.sensitivityCategories || []).includes("aadhaar") || /\baadhaar\b/i.test(textOf(element)))
  );
  const aadhaarPlaceholder = firstPlaceholder(payload, "AADHAAR") || firstProfileToken(payload, "aadhaar");
  if (
    aadhaar &&
    aadhaarPlaceholder &&
    !aadhaar.hasUserValue &&
    !alreadyApplied(history, "fill", aadhaar.id)
  ) {
    actions.push({ type: "fill", elementId: aadhaar.id, text: aadhaarPlaceholder });
  }

  const vaultBlocked = { password: true, otp: true, cvv: true, authentication_secret: true };
  elements.forEach((element) => {
    if (actions.length >= 14) {
      return;
    }
    if (!element || element.hasUserValue) {
      return;
    }
    const tag = String(element.tag || "").toLowerCase();
    const isSelect = tag === "select";
    if (tag !== "input" && tag !== "textarea" && !isSelect) {
      return;
    }
    const cats = element.sensitivityCategories || [];
    if (String(element.inputType || "").toLowerCase() === "password") {
      if (!cats.includes("security_pin")) {
        return;
      }
    }
    const type = isSelect ? "select" : "fill";
    if (alreadyApplied(history, type, element.id) || actions.some((action) => action.elementId === element.id)) {
      return;
    }
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      if (vaultBlocked[cat]) {
        continue;
      }
      const token = firstProfileToken(payload, cat);
      if (token) {
        actions.push({ type, elementId: element.id, text: token });
        return;
      }
    }
  });

  const select = elements.find((element) => element.tag === "select");
  if (select && !alreadyApplied(history, "select", select.id)) {
    const requested = (select.options || []).find((option) =>
      new RegExp(
        "(?:^|[^A-Za-z0-9])" +
          String(option).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "(?:$|[^A-Za-z0-9])",
        "i"
      ).test(payload.goal || "")
    );
    if (requested) {
      actions.push({
        type: "select",
        elementId: select.id,
        text: String(requested)
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

  const selectAccount = elements.some((element) =>
    /\bselect\s+account|create\s+(?:a\s+)?new\s+account\b/i.test(textOf(element))
  );
  const verifiedAccount = elements.find(
    (element) =>
      /\bverified\b/i.test(textOf(element)) &&
      !/\bunverified\b/i.test(textOf(element)) &&
      !/\bcreate\b/i.test(textOf(element))
  );
  if (
    selectAccount &&
    verifiedAccount &&
    !alreadyApplied(history, "click", verifiedAccount.id)
  ) {
    actions.push({ type: "click", elementId: verifiedAccount.id });
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
    if (selectAccount) {
      return {
        actions: [{ type: "wait", ms: 400 }],
        done: false
      };
    }
    return {
      actions: [{ type: "done", reason: "No additional safe mock action is available." }],
      done: true
    };
  }
  return { actions, done: false };
}
