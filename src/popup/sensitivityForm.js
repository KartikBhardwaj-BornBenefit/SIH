/**
 * Renders and persists the sensitive-data checklist in the popup.
 */
var SensitivityForm = (function () {
  var formEl = document.getElementById("policy-form");
  var policy = BrowserAgent.defaultSensitivityPolicy
    ? BrowserAgent.defaultSensitivityPolicy()
    : {};

  function getPolicy() {
    return BrowserAgent.normalizeSensitivityPolicy
      ? BrowserAgent.normalizeSensitivityPolicy(policy)
      : policy;
  }

  function save(next) {
    policy = getPolicyFrom(next);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      var payload = {};
      payload[BrowserAgent.SENSITIVITY_STORAGE_KEY] = policy;
      chrome.storage.local.set(payload);
    }
    syncCheckboxes();
  }

  function getPolicyFrom(next) {
    return BrowserAgent.normalizeSensitivityPolicy
      ? BrowserAgent.normalizeSensitivityPolicy(next)
      : next;
  }

  function syncCheckboxes() {
    if (!formEl) {
      return;
    }
    var boxes = formEl.querySelectorAll("input[type=checkbox][data-category]");
    boxes.forEach(function (box) {
      box.checked = Boolean(policy[box.getAttribute("data-category")]);
    });
  }

  function readForm() {
    var next = {};
    (BrowserAgent.SENSITIVITY_CATEGORIES || []).forEach(function (category) {
      next[category.id] = false;
    });
    if (!formEl) {
      return getPolicyFrom(next);
    }
    formEl.querySelectorAll("input[type=checkbox][data-category]").forEach(function (box) {
      next[box.getAttribute("data-category")] = box.checked;
    });
    return getPolicyFrom(next);
  }

  function render() {
    if (!formEl) {
      return;
    }
    formEl.replaceChildren();
    var groups = BrowserAgent.groupedSensitivityCategories
      ? BrowserAgent.groupedSensitivityCategories()
      : [];
    groups.forEach(function (group) {
      var fieldset = document.createElement("fieldset");
      fieldset.className = "policy-group";
      var legend = document.createElement("legend");
      legend.textContent = group.label;
      fieldset.appendChild(legend);
      group.items.forEach(function (category) {
        var label = document.createElement("label");
        label.className = "policy-item";
        var input = document.createElement("input");
        input.type = "checkbox";
        input.setAttribute("data-category", category.id);
        input.checked = Boolean(policy[category.id]);
        var text = document.createElement("span");
        var title = document.createElement("strong");
        title.textContent = category.label;
        var hint = document.createElement("small");
        hint.textContent = category.description + " · " + category.level.replace("_", " ");
        text.appendChild(title);
        text.appendChild(hint);
        label.appendChild(input);
        label.appendChild(text);
        fieldset.appendChild(label);
      });
      formEl.appendChild(fieldset);
    });
  }

  function setAll(value) {
    var next = {};
    (BrowserAgent.SENSITIVITY_CATEGORIES || []).forEach(function (category) {
      next[category.id] = value;
    });
    save(next);
  }

  function loadAndRender() {
    render();
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return;
    }
    chrome.storage.local.get(BrowserAgent.SENSITIVITY_STORAGE_KEY, function (stored) {
      if (stored && stored[BrowserAgent.SENSITIVITY_STORAGE_KEY]) {
        policy = getPolicyFrom(stored[BrowserAgent.SENSITIVITY_STORAGE_KEY]);
        syncCheckboxes();
      }
    });
  }

  if (formEl) {
    formEl.addEventListener("change", function () {
      save(readForm());
    });
  }

  var allBtn = document.getElementById("policy-all");
  var noneBtn = document.getElementById("policy-none");
  var resetBtn = document.getElementById("policy-reset");
  if (allBtn) {
    allBtn.addEventListener("click", function () {
      setAll(true);
    });
  }
  if (noneBtn) {
    noneBtn.addEventListener("click", function () {
      setAll(false);
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      save(BrowserAgent.defaultSensitivityPolicy());
    });
  }

  loadAndRender();

  return {
    getPolicy: getPolicy
  };
})();
