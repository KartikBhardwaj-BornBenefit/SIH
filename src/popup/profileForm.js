/**
 * Local fill-profile editor. Values stay in chrome.storage.local on this
 * device and are never shown to the remote planner.
 */
var ProfileForm = (function () {
  var formEl = document.getElementById("profile-form");
  var statusEl = document.getElementById("profile-status");
  var vault = BrowserAgent.profileVault;

  function setStatus(message, isError) {
    if (!statusEl) {
      return;
    }
    if (!message) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  function render(store) {
    if (!formEl || !vault) {
      return;
    }
    formEl.replaceChildren();
    vault.allowedCategories().forEach(function (category) {
      var label = document.createElement("label");
      label.className = "policy-item profile-item";
      var text = document.createElement("span");
      var title = document.createElement("strong");
      title.textContent = category.label + (category.highRisk ? " · high-risk" : "");
      var hint = document.createElement("small");
      var saved = store.values[category.id];
      hint.textContent = saved
        ? vault.maskValue(saved) + " · " + category.placeholder
        : "Not saved · " + category.placeholder;
      text.appendChild(title);
      text.appendChild(hint);
      var input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("data-category", category.id);
      input.placeholder = saved ? "Leave blank to keep" : "Not stored";
      label.appendChild(text);
      label.appendChild(input);
      formEl.appendChild(label);
    });
  }

  function currentStoreThen(next) {
    if (!vault) {
      next({ values: {} });
      return;
    }
    vault.load().then(next).catch(function () {
      next(vault.emptyStore());
    });
  }

  function saveFromForm() {
    if (!vault) {
      setStatus("Profile storage is unavailable.", true);
      return;
    }
    currentStoreThen(function (store) {
      var next = { values: Object.assign({}, store.values) };
      var errors = [];
      formEl.querySelectorAll("input[data-category]").forEach(function (input) {
        var category = input.getAttribute("data-category");
        var raw = input.value.trim();
        if (!raw) {
          return;
        }
        if (vault.isHighRisk(category) && !window.confirm("Save " + category.replace(/_/g, " ") + " on this device? It is not sent to the server.")) {
          return;
        }
        var checked = vault.validateValue(category, raw);
        if (!checked.ok) {
          errors.push(checked.error);
          return;
        }
        next.values[category] = checked.value;
        input.value = "";
      });
      if (errors.length) {
        setStatus(errors[0], true);
        return;
      }
      vault.save(next).then(function (saved) {
        render(saved);
        var count = Object.keys(saved.values).length;
        setStatus(
          count
            ? count + " value(s) saved on this device. The planner only sees tokens."
            : "Profile is empty."
        );
      }).catch(function (error) {
        setStatus(error && error.message ? error.message : "Could not save the profile.", true);
      });
    });
  }

  function clearProfile() {
    if (!vault) {
      return;
    }
    if (!window.confirm("Clear all locally stored profile values from this device?")) {
      return;
    }
    vault.clear().then(function (saved) {
      render(saved);
      setStatus("Local profile cleared.");
    }).catch(function (error) {
      setStatus(error && error.message ? error.message : "Could not clear the profile.", true);
    });
  }

  currentStoreThen(render);

  var saveBtn = document.getElementById("profile-save");
  var clearBtn = document.getElementById("profile-clear");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveFromForm);
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", clearProfile);
  }

  return {
    reload: function () {
      currentStoreThen(render);
    }
  };
})();
