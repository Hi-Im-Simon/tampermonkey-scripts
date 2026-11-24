// ==UserScript==
// @name         Study Sorter
// @namespace    study-sorter
// @version      2.5.1
// @description  Sort and highlight studies with editable rules, numeric conditions and sort priorities.
// @match        https://config.example.invalid/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        window.onurlchange
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const SETTINGS_KEY = "study-sorter-settings-v2";
  const SETTINGS_FORMAT = "study-sorter";
  const SETTINGS_FORMAT_VERSION = 1;
  const TOGGLE_LABELS = {
    hideNativeControls: "Hide sorting and filters",
    compactScoreGroups: "Compact score groups",
    selectTopStudy: "Select top study after sorting",
  };
  const SECTION = ".available-studies-section";
  const LIST = SECTION + " > ul";
  const LIST_HEADER = ".study-list-header";
  const NATIVE_CONTROLS = LIST_HEADER + " > .sorting-filtering-wrapper";
  const OBSERVED_SECTIONS = SECTION + ", " + LIST_HEADER;
  const COMPACT_GAP = 2;
  const GROUP_GAP = 12;
  const TITLE = ".details-group > .details > h2 > a";
  const PUBLISHER = ".details-group > .details > .host > span";
  const FIELDS = {
    name: "Study name",
    publisher: "Publisher",
    places: "Available places",
    reward: "Reward",
    hourlyReward: "Reward per hour",
  };
  const NUMERIC_FIELDS = {
    places: FIELDS.places,
    reward: FIELDS.reward,
    hourlyReward: FIELDS.hourlyReward,
  };
  const TAGS = {
    places: "study-tag-places",
    reward: "study-tag-reward",
    hourlyReward: "study-tag-reward-per-hour",
  };
  const OPERATORS = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
  const DIRECTIONS = { asc: "Ascending", desc: "Descending" };
  const DEFAULT_SETTINGS = {
    defaultSort: [],
    hideNativeControls: true,
    compactScoreGroups: true,
    selectTopStudy: true,
    colors: [
      { score: -100, color: "#ef4444" },
      { score: 100, color: "#22c55e" },
    ],
    rules: [],
  };

  const collator = new Intl.Collator("en", {
    sensitivity: "base",
    numeric: true,
  });
  let settings = GM_getValue(SETTINGS_KEY, DEFAULT_SETTINGS);
  const liveOptions = Object.fromEntries(
    Object.keys(TOGGLE_LABELS).map((key) => [
      key,
      settings[key] ?? DEFAULT_SETTINGS[key],
    ]),
  );
  let compiledRules = compileRules(settings.rules);
  let colorStops = compileColors(settings.colors ?? DEFAULT_SETTINGS.colors);
  let previewColorStops = colorStops;
  const activeLists = new Set();
  const activeItems = new Set();
  const detachedControls = new Map();
  let updateScheduled = false;
  let lastTopStudyKey = null;
  let patternInputCount = 0;
  let textPick = null;
  let hoveredText = null;

  function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function compilePatterns(patterns = []) {
    return patterns.map((pattern) => {
      const source = normalizeText(pattern)
        .split(/\*+/)
        .map((segment) => segment.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp("^" + source + "$", "iu");
    });
  }

  function compileRules(rules) {
    return rules.map((rule) => ({
      ...rule,
      namePatterns: compilePatterns(rule.names),
      publisherPatterns: compilePatterns(rule.publishers),
    }));
  }

  function matchesPatterns(patterns, value) {
    return (
      patterns.length === 0 ||
      (value !== "" && patterns.some((pattern) => pattern.test(value)))
    );
  }

  function matchesCondition(condition, study) {
    const actual = study[condition.field];
    if (actual === null) return false;

    switch (condition.operator) {
      case "gt":
        return actual > condition.value;
      case "gte":
        return actual >= condition.value;
      case "lt":
        return actual < condition.value;
      case "lte":
        return actual <= condition.value;
      case "eq":
        return actual === condition.value;
      default:
        return false;
    }
  }

  function getMatchingRule(study) {
    return compiledRules.find(
      (rule) =>
        matchesPatterns(rule.namePatterns, study.name) &&
        matchesPatterns(rule.publisherPatterns, study.publisher) &&
        (rule.conditions ?? []).every((condition) =>
          matchesCondition(condition, study),
        ),
    );
  }

  function readNumber(text, isCount) {
    const token = text.match(/\d+(?:[.,]\d+|[ \u00a0\u202f]\d{3}\b)*/)?.[0];
    if (!token) return null;

    const compact = token.replace(/\s/g, "");
    const lastSeparator = Math.max(
      compact.lastIndexOf("."),
      compact.lastIndexOf(","),
    );
    // Counts use grouping separators. Monetary amounts usually show one or two decimal digits.
    const hasDecimal =
      !isCount &&
      lastSeparator >= 0 &&
      ((compact.includes(".") && compact.includes(",")) ||
        compact.length - lastSeparator <= 3);
    const numberText = hasDecimal
      ? compact.slice(0, lastSeparator).replace(/[.,]/g, "") +
        "." +
        compact.slice(lastSeparator + 1)
      : compact.replace(/[.,]/g, "");
    const number = Number(numberText);
    return Number.isFinite(number) ? number : null;
  }

  function readTag(item, field) {
    const tag = item.querySelector('[data-testid="' + TAGS[field] + '"]');
    if (!tag) return null;

    const amount = tag.matches(".amount") ? tag : tag.querySelector(".amount");
    for (const text of [
      amount?.textContent,
      tag.textContent,
      tag.getAttribute("aria-label"),
      tag.title,
    ]) {
      const value = readNumber(text ?? "", field === "places");
      if (value !== null) return value;
    }
    return null;
  }

  function readStudy(item, originalIndex) {
    const name = normalizeText(item.querySelector(TITLE)?.textContent ?? "");
    if (!name) return null;

    const study = {
      item,
      originalIndex,
      name,
      publisher: normalizeText(
        item.querySelector(PUBLISHER)?.textContent ?? "",
      ),
      places: readTag(item, "places"),
      reward: readTag(item, "reward"),
      hourlyReward: readTag(item, "hourlyReward"),
    };
    study.rule = getMatchingRule(study);
    study.score = study.rule?.score ?? 0;
    return study;
  }

  function compareFields(first, second, sort) {
    for (const { field, direction } of sort) {
      const left = first[field];
      const right = second[field];
      if (left === right) continue;
      if (left === null || left === "") return 1;
      if (right === null || right === "") return -1;

      const comparison =
        typeof left === "number" ? left - right : collator.compare(left, right);
      if (comparison) return direction === "asc" ? comparison : -comparison;
    }
    return 0;
  }

  function orderStudies(studies) {
    const ordered = [...studies].sort(
      (first, second) =>
        second.score - first.score ||
        compareFields(first, second, settings.defaultSort) ||
        first.originalIndex - second.originalIndex,
    );

    // A rule's sort order only rearranges the slots occupied by that rule's studies.
    const groups = new Map();
    ordered.forEach((study, index) => {
      if (!study.rule?.sort?.length) return;
      if (!groups.has(study.rule))
        groups.set(study.rule, { studies: [], positions: [] });
      const group = groups.get(study.rule);
      group.studies.push(study);
      group.positions.push(index);
    });
    for (const [rule, group] of groups) {
      group.studies.sort((first, second) =>
        compareFields(first, second, rule.sort),
      );
      group.positions.forEach((position, index) => {
        ordered[position] = group.studies[index];
      });
    }
    return ordered;
  }

  function setStyle(element, name, value) {
    if (element.style.getPropertyValue(name) !== value)
      element.style.setProperty(name, value);
  }

  function clearStudy(item) {
    item.removeAttribute("data-pss-item");
    item.removeAttribute("data-pss-highlight");
    item.removeAttribute("data-pss-gap");
    for (const name of ["--pss-order", "--pss-border", "--pss-background"]) {
      item.style.removeProperty(name);
    }
  }

  function compileColors(colors) {
    const stops = { negative: [], positive: [] };
    for (const { score, color } of colors) {
      const channels = color
        .slice(1)
        .match(/../g)
        .map((channel) => parseInt(channel, 16));
      stops[score < 0 ? "negative" : "positive"].push({
        magnitude: Math.abs(score),
        channels,
      });
    }
    stops.negative.sort((first, second) => first.magnitude - second.magnitude);
    stops.positive.sort((first, second) => first.magnitude - second.magnitude);
    return stops;
  }

  function getScoreColor(score, palette = colorStops) {
    if (!score) return null;
    const stops = palette[score < 0 ? "negative" : "positive"];
    if (!stops.length) return null;

    const magnitude = Math.abs(score);
    const upperIndex = stops.findIndex((stop) => stop.magnitude >= magnitude);
    const upper = stops[upperIndex];
    let channels = (upper ?? stops.at(-1)).channels;
    if (upperIndex > 0) {
      const lower = stops[upperIndex - 1];
      const fraction =
        (magnitude - lower.magnitude) / (upper.magnitude - lower.magnitude);
      channels = lower.channels.map((channel, index) =>
        Math.round(channel + (upper.channels[index] - channel) * fraction),
      );
    }
    const intensity = Math.min(magnitude / stops[0].magnitude, 1);
    return {
      border:
        "rgba(" + channels.join(", ") + ", " + (0.18 + intensity * 0.82) + ")",
      background:
        "rgba(" + channels.join(", ") + ", " + (0.02 + intensity * 0.16) + ")",
    };
  }

  function decorateStudy({ item, score }, position, gap) {
    if (!item.hasAttribute("data-pss-item"))
      item.setAttribute("data-pss-item", "");
    setStyle(item, "--pss-order", String(position));
    if (gap) item.setAttribute("data-pss-gap", gap);
    else item.removeAttribute("data-pss-gap");
    const color = getScoreColor(score);
    item.toggleAttribute("data-pss-highlight", Boolean(color));
    if (!color) {
      item.style.removeProperty("--pss-border");
      item.style.removeProperty("--pss-background");
      return;
    }
    setStyle(item, "--pss-border", color.border);
    setStyle(item, "--pss-background", color.background);
  }

  function isStudiesPage() {
    return /^\/studies\/?$/.test(location.pathname);
  }

  function updateNativeControls(hide) {
    for (const [header, { controls, marker }] of detachedControls) {
      if (
        hide &&
        header.isConnected &&
        header.matches(LIST_HEADER) &&
        marker.parentNode === header
      )
        continue;
      if (
        marker.parentNode === header &&
        !header.querySelector(":scope > .sorting-filtering-wrapper")
      ) {
        marker.replaceWith(controls);
      } else {
        marker.remove();
      }
      detachedControls.delete(header);
    }

    if (!hide) return;
    for (const controls of document.querySelectorAll(NATIVE_CONTROLS)) {
      const header = controls.parentElement;
      detachedControls.get(header)?.marker.remove();
      const marker = document.createComment("Study Sorter: native controls");
      controls.replaceWith(marker);
      detachedControls.set(header, { controls, marker });
    }
  }

  function updateTopStudyPreview(study) {
    if (!liveOptions.selectTopStudy || !study) {
      lastTopStudyKey = null;
      return;
    }
    if (textPick) return;

    const title = study.item.querySelector(TITLE);
    const href = title?.getAttribute("href");
    const key = JSON.stringify([
      study.item.id,
      href,
      study.name,
      study.publisher,
    ]);
    if (key === lastTopStudyKey) return;
    lastTopStudyKey = key;

    // A card click opens the preview without following the title's link.
    const target =
      title && (!href || href === "#")
        ? title
        : study.item.querySelector(":scope > div");
    (target ?? study.item).click();
  }

  function updateStudies() {
    updateScheduled = false;
    const onStudiesPage = isStudiesPage();
    if (onStudiesPage && !panelHost.isConnected)
      document.body.append(panelHost);
    if (!onStudiesPage) stopPicking();
    panelHost.hidden = !onStudiesPage;
    updateNativeControls(onStudiesPage && liveOptions.hideNativeControls);
    const visibleLists = new Set(
      onStudiesPage ? document.querySelectorAll(LIST) : [],
    );
    const visibleItems = new Set();
    let topStudy = null;

    for (const list of visibleLists) {
      const studies = [...list.querySelectorAll(":scope > li")]
        .map(readStudy)
        .filter(Boolean);
      if (!studies.length) {
        list.removeAttribute("data-pss-stack");
        list.removeAttribute("data-pss-compact");
        continue;
      }
      if (
        !list.hasAttribute("data-pss-stack") &&
        !/(flex|grid)/.test(getComputedStyle(list).display)
      ) {
        list.setAttribute("data-pss-stack", "");
      }
      const compact = liveOptions.compactScoreGroups && studies.length > 1;
      list.toggleAttribute("data-pss-compact", compact);
      const ordered = orderStudies(studies);
      ordered.forEach((study, index) => {
        visibleItems.add(study.item);
        const previous = ordered[index - 1];
        const gap =
          compact &&
          previous &&
          (study.score === previous.score ? "compact" : "group");
        decorateStudy(study, index, gap);
      });
      if (liveOptions.selectTopStudy) {
        topStudy ??=
          ordered.find(({ item }) => item.getClientRects().length > 0) ?? null;
      }
    }

    for (const list of activeLists) {
      if (!visibleLists.has(list)) {
        list.removeAttribute("data-pss-stack");
        list.removeAttribute("data-pss-compact");
      }
    }
    for (const item of activeItems) {
      if (!visibleItems.has(item)) clearStudy(item);
    }
    activeLists.clear();
    activeItems.clear();
    visibleLists.forEach((list) => activeLists.add(list));
    visibleItems.forEach((item) => activeItems.add(item));
    updateTopStudyPreview(topStudy);
  }

  function scheduleUpdate() {
    if (updateScheduled) return;
    updateScheduled = true;
    requestAnimationFrame(updateStudies);
  }

  function affectsStudyPage(record) {
    const target =
      record.target.nodeType === Node.ELEMENT_NODE
        ? record.target
        : record.target.parentElement;

    if (target?.closest(OBSERVED_SECTIONS)) return true;
    if (record.type === "attributes") {
      return (
        detachedControls.has(target) ||
        [...activeLists].some((list) => target?.contains(list))
      );
    }
    return [...record.addedNodes, ...record.removedNodes].some(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        (node.matches(OBSERVED_SECTIONS) ||
          node.querySelector(OBSERVED_SECTIONS)),
    );
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, onClick, className) {
    const node = element("button", text, className);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function iconButton(text, label, onClick, disabled = false) {
    const node = button(text, onClick, "icon-button");
    node.title = label;
    node.setAttribute("aria-label", label);
    node.disabled = disabled;
    return node;
  }

  function select(options, value, label) {
    const node = element("select");
    node.setAttribute("aria-label", label);
    for (const [key, text] of Object.entries(options)) {
      const option = element("option", text);
      option.value = key;
      node.append(option);
    }
    node.value = value;
    return node;
  }

  function numberInput(value, label, placeholder) {
    const node = element("input");
    node.type = "number";
    node.step = "any";
    node.value = value ?? "";
    if (label) node.setAttribute("aria-label", label);
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  function labeledField(text, control) {
    const label = element("label", text, "field");
    label.append(control);
    return label;
  }

  function moveItem(items, from, to) {
    items.splice(to, 0, items.splice(from, 1)[0]);
  }

  function sortEditor(initialSort = [], onCountChange) {
    const editor = element("div", "", "editor");
    const rows = element("div", "", "rows");
    const criteria = initialSort.map(({ field, direction }) => ({
      element: element("div", "", "row sort-row"),
      field: select(FIELDS, field, "Sort field"),
      direction: select(DIRECTIONS, direction, "Sort direction"),
    }));

    function updateOptions() {
      const used = new Set(criteria.map((criterion) => criterion.field.value));
      for (const { field } of criteria) {
        for (const option of field.options) {
          option.disabled =
            option.value !== field.value && used.has(option.value);
        }
      }
      add.disabled = used.size === Object.keys(FIELDS).length;
    }

    function render(focusIndex) {
      rows.replaceChildren();
      criteria.forEach((criterion, index) => {
        const move = (offset) => {
          moveItem(criteria, index, index + offset);
          render(index + offset);
        };
        criterion.element.replaceChildren(
          criterion.field,
          criterion.direction,
          iconButton("↑", "Move sort priority up", () => move(-1), index === 0),
          iconButton(
            "↓",
            "Move sort priority down",
            () => move(1),
            index === criteria.length - 1,
          ),
          iconButton("×", "Remove sort priority", () => {
            criteria.splice(index, 1);
            render();
            add.focus();
          }),
        );
        rows.append(criterion.element);
      });
      updateOptions();
      onCountChange?.(criteria.length);
      if (focusIndex !== undefined) criteria[focusIndex].field.focus();
      markUnsaved();
    }

    const add = button(
      "+ Add sort priority",
      () => {
        const used = new Set(
          criteria.map((criterion) => criterion.field.value),
        );
        const field = Object.keys(FIELDS).find((key) => !used.has(key));
        if (!field) return;
        criteria.push({
          element: element("div", "", "row sort-row"),
          field: select(FIELDS, field, "Sort field"),
          direction: select(
            DIRECTIONS,
            field in NUMERIC_FIELDS ? "desc" : "asc",
            "Sort direction",
          ),
        });
        render(criteria.length - 1);
      },
      "add-button",
    );

    rows.addEventListener("change", updateOptions);
    render();
    editor.append(rows, add);
    return {
      element: editor,
      read: () =>
        criteria.map(({ field, direction }) => ({
          field: field.value,
          direction: direction.value,
        })),
    };
  }

  function conditionsEditor(initialConditions = []) {
    const editor = element("div", "", "editor");
    const rows = element("div", "", "rows");
    const conditions = [];

    function addCondition({ field = "reward", operator = "gt", value } = {}) {
      const row = element("div", "", "row condition-row");
      const condition = {
        field: select(NUMERIC_FIELDS, field, "Condition field"),
        operator: select(OPERATORS, operator, "Comparison"),
        value: numberInput(value, "Threshold", "Threshold"),
      };
      row.append(
        condition.field,
        condition.operator,
        condition.value,
        iconButton("×", "Remove condition", () => {
          conditions.splice(conditions.indexOf(condition), 1);
          row.remove();
          add.focus();
          markUnsaved();
        }),
      );
      conditions.push(condition);
      rows.append(row);
      return condition;
    }

    const add = button(
      "+ Add condition",
      () => {
        addCondition().value.focus();
        markUnsaved();
      },
      "add-button",
    );
    initialConditions.forEach(addCondition);
    editor.append(rows, add);
    return {
      element: editor,
      invalidInput: () =>
        conditions.find(
          (condition) => !Number.isFinite(condition.value.valueAsNumber),
        )?.value,
      read: () =>
        conditions.map(({ field, operator, value }) => ({
          field: field.value,
          operator: operator.value,
          value: value.valueAsNumber,
        })),
    };
  }

  function patternsInput(patterns, placeholder) {
    const node = element("textarea");
    node.rows = 2;
    node.placeholder = placeholder;
    node.value = (patterns ?? []).join("\n");
    return node;
  }

  function readPatterns(input) {
    return input.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function patternField(text, input) {
    const container = element("div", "", "field");
    const top = element("div", "", "field-header");
    const label = element("label", text);
    input.id = "pattern-input-" + ++patternInputCount;
    label.htmlFor = input.id;
    const pick = button(
      "Pick text",
      () => {
        const wasPicking = textPick?.input === input;
        stopPicking();
        if (wasPicking) return;
        textPick = { input, button: pick };
        panel.hidden = true;
        pickNotice.hidden = false;
        cancelPick.focus();
      },
      "pick-button",
    );
    pick.setAttribute("aria-label", "Pick text for " + text.toLowerCase());
    top.append(label, pick);
    container.append(top, input);
    return container;
  }

  function stopPicking() {
    if (!textPick) return;
    textPick = null;
    pickNotice.hidden = true;
    panel.hidden = false;
    highlightPickedText(null);
  }

  function cancelPicking() {
    const pickButton = textPick?.button;
    stopPicking();
    pickButton?.focus();
  }

  function highlightPickedText(target) {
    if (hoveredText === target) return;
    hoveredText?.removeAttribute("data-pss-pick-target");
    hoveredText = target;
    hoveredText?.setAttribute("data-pss-pick-target", "");
  }

  function getPickTarget(event) {
    if (
      event.composedPath().includes(panelHost) ||
      !(event.target instanceof Element)
    )
      return null;
    const clicked = event.target;
    const textElement =
      clicked.closest(TITLE + ", " + PUBLISHER) ??
      clicked.closest(
        "a, span, p, label, button, strong, em, h1, h2, h3, h4",
      ) ??
      clicked;
    const text = normalizeText(textElement.textContent ?? "");
    return text && text.length <= 500 ? { element: textElement, text } : null;
  }

  function pickPageText(event) {
    if (!textPick || event.composedPath().includes(panelHost)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = getPickTarget(event);
    if (!target) return;

    const input = textPick.input;
    if (
      !readPatterns(input).some(
        (pattern) =>
          normalizeText(pattern).toLowerCase() === target.text.toLowerCase(),
      )
    ) {
      input.value = [...readPatterns(input), target.text].join("\n");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    stopPicking();
    input.focus();
  }

  function ruleEditor(rule) {
    const box = element("details", "", "rule");
    const summary = element("summary", "", "summary-line");
    const summaryScore = element("span", "", "rule-score");
    const summaryText = element("span", "", "rule-name");
    const summaryCount = element("span", "", "pattern-count");
    summary.append(summaryScore, summaryText, summaryCount);

    const names = patternsInput(rule.names, "Example title *");
    const publishers = patternsInput(rule.publishers, "Example publisher *");
    const score = numberInput(rule.score, "", "0");
    const conditions = conditionsEditor(rule.conditions);
    const sort = sortEditor(rule.sort);
    const actions = element("div", "", "rule-actions");
    const body = element("div", "", "rule-body");
    body.append(
      patternField("Study names", names),
      patternField("Publishers", publishers),
      labeledField("Score", score),
      element("h3", "Numeric conditions"),
      conditions.element,
      element("h3", "Sort priorities"),
      sort.element,
      actions,
    );
    box.append(summary, body);

    function updateSummary() {
      const studyNames = readPatterns(names);
      const studyPublishers = readPatterns(publishers);
      const numericConditions = conditions.read();
      const description = [
        studyNames.join(" / "),
        studyPublishers.join(" / "),
        numericConditions
          .map(
            ({ field, operator, value }) =>
              FIELDS[field] +
              " " +
              OPERATORS[operator] +
              " " +
              (Number.isFinite(value) ? value : "…"),
          )
          .join(" · "),
      ]
        .filter(Boolean)
        .join(" · ");
      summaryScore.textContent = score.value || "0";
      summaryScore.title = "Score " + summaryScore.textContent;
      summaryText.textContent = description || "All studies";
      summaryText.title = summaryText.textContent;
      const patternCount = studyNames.length + studyPublishers.length;
      summaryCount.hidden = patternCount < 2;
      summaryCount.textContent = "(" + patternCount + " patterns)";
    }

    function updateColor() {
      const color = getScoreColor(score.valueAsNumber, previewColorStops);
      if (color) {
        box.style.setProperty(
          "background-color",
          color.background,
          "important",
        );
        box.style.setProperty("border-color", color.border, "important");
      } else {
        box.style.removeProperty("background-color");
        box.style.removeProperty("border-color");
      }
    }

    body.addEventListener("input", updateSummary);
    body.addEventListener("click", updateSummary);
    score.addEventListener("input", updateColor);
    updateSummary();
    updateColor();
    return {
      element: box,
      actions,
      updateColor,
      focus: () => names.focus(),
      missingMatch: () =>
        !readPatterns(names).length &&
        !readPatterns(publishers).length &&
        !conditions.read().length,
      invalidInput: () =>
        Number.isFinite(score.valueAsNumber)
          ? conditions.invalidInput()
          : score,
      read: () => ({
        names: readPatterns(names),
        publishers: readPatterns(publishers),
        score: score.valueAsNumber,
        conditions: conditions.read(),
        sort: sort.read(),
      }),
    };
  }

  function colorEditor(initialColors, onChange) {
    const editor = element("div", "", "default-sort");
    const rows = element("div", "", "rows");
    const neutralRow = element("div", "", "row color-row");
    const neutralScore = numberInput(0, "Neutral score");
    neutralScore.disabled = true;
    const neutralLabel = element("span", "", "neutral-color-label");
    neutralLabel.append(
      element("span", "", "color-swatch-chip"),
      element("span", "Neutral"),
    );
    neutralRow.append(neutralScore, neutralLabel);
    rows.append(neutralRow);
    const feedback = element("p", "", "status");
    const colors = [];
    feedback.setAttribute("role", "status");
    feedback.setAttribute("data-error", "");
    feedback.hidden = true;

    function showFeedback(message = "") {
      feedback.textContent = message;
      feedback.hidden = !message;
    }

    function commitScore(stop) {
      const value = stop.score.valueAsNumber;
      if (value === stop.committedScore) return;

      let message = "";
      if (!Number.isFinite(value) || value === 0) {
        message = "Enter a nonzero color score.";
      } else if (
        colors.some((other) => other !== stop && other.committedScore === value)
      ) {
        message = "Score " + value + " already has a color.";
      }
      if (message) {
        stop.score.value = stop.committedScore ?? "";
        showFeedback(message);
        return;
      }

      stop.committedScore = value;
      colors.sort(
        (first, second) =>
          (first.committedScore ?? Infinity) -
          (second.committedScore ?? Infinity),
      );
      const nextStop = colors[colors.indexOf(stop) + 1];
      const nextRow =
        value < 0 && (nextStop?.committedScore ?? Infinity) >= 0
          ? neutralRow
          : (nextStop?.row ?? null);
      if (stop.row.nextElementSibling !== nextRow)
        rows.insertBefore(stop.row, nextRow);
      showFeedback();
      onChange();
    }

    function addColor({ score, color = "#7c3aed" } = {}) {
      const row = element("div", "", "row color-row");
      const stop = {
        row,
        score: numberInput(score, "Color score", "Score"),
        committedScore: score,
        color: element("input"),
      };
      stop.color.type = "color";
      stop.color.value = color;
      stop.color.setAttribute("aria-label", "Highlight color");
      stop.score.addEventListener("input", () => showFeedback());
      stop.score.addEventListener("blur", () => commitScore(stop));
      stop.color.addEventListener("input", onChange);
      row.append(
        stop.score,
        stop.color,
        iconButton("×", "Remove color", () => {
          colors.splice(colors.indexOf(stop), 1);
          row.remove();
          add.focus();
          showFeedback();
          onChange();
          markUnsaved();
        }),
      );
      colors.push(stop);
      rows.insertBefore(row, score < 0 ? neutralRow : null);
      return stop;
    }

    const add = button(
      "+ Add color",
      () => {
        addColor().score.focus();
        markUnsaved();
      },
      "add-button",
    );
    [...initialColors]
      .sort((first, second) => first.score - second.score)
      .forEach(addColor);
    editor.append(
      element(
        "p",
        "Higher scores appear first. 0 is neutral and uncolored. Scores can go below −100 or above 100.",
        "hint",
      ),
      element(
        "p",
        "The default colors reach full strength at −100 and 100. Set colors at any nonzero score. Colors blend between scores on the same side of 0 and keep the outermost color beyond that point. A side with no colors stays uncolored.",
        "hint",
      ),
      rows,
      feedback,
      add,
    );
    return {
      element: editor,
      invalidInput() {
        const seen = new Set();
        for (const { score } of colors) {
          const value = score.valueAsNumber;
          if (!Number.isFinite(value) || value === 0 || seen.has(value))
            return score;
          seen.add(value);
        }
        return null;
      },
      read: () =>
        colors.map(({ score, color }) => ({
          score: score.valueAsNumber,
          color: color.value,
        })),
    };
  }

  function installStyles(root, css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }

  installStyles(
    document,
    `
    .available-studies-section > ul[data-pss-stack] {
      display: flex;
      flex-direction: column;
    }
    .available-studies-section > ul > li[data-pss-item] {
      order: var(--pss-order);
    }
    .available-studies-section > ul[data-pss-compact] {
      row-gap: 0 !important;
    }
    .available-studies-section > ul[data-pss-compact] > li[data-pss-item],
    .available-studies-section > ul[data-pss-compact] > li[data-pss-item] > div:first-of-type {
      margin-block: 0 !important;
    }
    .available-studies-section > ul[data-pss-compact] > li[data-pss-gap="compact"] > div:first-of-type {
      margin-block-start: ${COMPACT_GAP}px !important;
    }
    .available-studies-section > ul[data-pss-compact] > li[data-pss-gap="group"] > div:first-of-type {
      margin-block-start: ${GROUP_GAP}px !important;
    }
    .available-studies-section > ul > li[data-pss-highlight] > div:first-of-type {
      outline: 3px solid var(--pss-border);
      outline-offset: -3px;
      background-color: var(--pss-background);
    }
    [data-pss-pick-target] {
      outline: 2px dashed #5656cc !important;
      outline-offset: 3px;
      cursor: crosshair !important;
    }
  `,
  );

  const panelHost = element("div");
  const shadow = panelHost.attachShadow({ mode: "open" });
  installStyles(
    shadow,
    `
    :host {
      all: initial;
      display: block;
      position: fixed;
      inset: auto auto 16px 16px;
      z-index: 2147483647;
      color: #202237;
      font: 14px/1.45 system-ui, sans-serif;
      color-scheme: light;
    }
    :host([hidden]), [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    button, input, textarea, select { font: inherit; }
    button {
      border: 1px solid #d8dbea;
      border-radius: 8px;
      background: #fff;
      color: #252941;
      padding: 6px 10px;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: #edeefd; }
    button:disabled { opacity: .4; cursor: default; }
    :focus-visible { outline: 2px solid #5656cc; outline-offset: 2px; }
    .primary {
      background: #3c409b;
      color: white;
      border-color: #3c409b;
      font-weight: 650;
    }
    .primary:hover:not(:disabled) { background: #30347f; }
    .launcher { padding: 9px 15px; box-shadow: 0 3px 14px #2022372e; }
    .panel {
      width: min(540px, calc(100vw - 32px));
      max-height: min(740px, calc(100dvh - 32px));
      display: flex;
      flex-direction: column;
      background: #fff;
      border: 1px solid #d8dbea;
      border-radius: 14px;
      box-shadow: 0 12px 36px #20223735;
      overflow: hidden;
    }
    header, footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 16px;
      background: #f5f5fe;
    }
    header { border-bottom: 1px solid #e4e5ef; }
    footer { border-top: 1px solid #e4e5ef; }
    h2, h3, p { margin: 0; }
    h2 { font-size: 17px; }
    h3 { font-size: 14px; }
    .content { overflow: auto; padding: 14px; overscroll-behavior: contain; }
    .hint { color: #555a74; font-size: 12px; margin: 4px 0 9px; }
    .rules-header { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
    .rules, .rows { display: grid; gap: 6px; }
    details { border: 1px solid #e0e2ef; border-radius: 8px; }
    .content > details { margin-bottom: 6px; }
    summary {
      padding: 8px 10px;
      cursor: pointer;
      overflow-wrap: anywhere;
      font-weight: 650;
    }
    details[open] > summary { background: #f7f7fd; }
    .summary-line {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      white-space: nowrap;
    }
    .summary-line::-webkit-details-marker { display: none; }
    .summary-line::before {
      content: "";
      flex: none;
      width: 6px;
      height: 6px;
      margin-inline: 2px 3px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(-45deg);
    }
    details[open] > .summary-line::before { transform: translateY(-1px) rotate(45deg); }
    .summary-label, .pattern-count { flex: none; }
    .summary-count {
      flex: none;
      margin-inline-start: auto;
      padding-inline: 6px;
      border-radius: 6px;
      background: #ebecfa;
      color: #353990;
      font-size: 12px;
    }
    .color-swatches {
      display: flex;
      flex: 1;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-content: flex-start;
      gap: 4px;
      min-width: 0;
      height: 22px;
      overflow: hidden;
    }
    .color-swatch {
      display: inline-flex;
      flex: none;
      align-items: center;
      gap: 4px;
      height: 22px;
      padding-inline: 5px;
      border: 1px solid #d8dbea;
      border-radius: 5px;
      background: #fff;
      font-size: 11px;
    }
    .color-swatch-chip {
      width: 12px;
      height: 12px;
      flex: none;
      border: 1px solid #20223725;
      border-radius: 2px;
      forced-color-adjust: none;
    }
    .color-swatch-score, .rule-name, .rule-score {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .color-swatch-score, .rule-score { max-width: 9ch; }
    .rule { min-width: 0; }
    .rule[open] > summary { background: transparent; }
    .rule-score { flex: none; font-variant-numeric: tabular-nums; }
    .rule-name { min-width: 0; }
    .pattern-count { color: #555a74; font-size: 12px; }
    .default-sort { padding: 0 10px 10px; }
    .setting-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px 10px;
      cursor: pointer;
    }
    .setting-toggle input {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: #3c409b;
    }
    .settings-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      padding: 0 10px 10px;
    }
    .rule-body { display: grid; gap: 8px; padding: 10px; }
    .rule-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
    .field { display: grid; gap: 3px; font-weight: 550; }
    .field-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .pick-button { padding: 3px 7px; color: #353990; font-size: 12px; }
    .pick-notice {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: calc(100vw - 32px);
      padding: 8px 10px;
      border: 1px solid #d8dbea;
      border-radius: 8px;
      color: #25296c;
      background: #f5f5fe;
      box-shadow: 0 3px 14px #2022372e;
      font-size: 12px;
    }
    textarea, input, select {
      width: 100%;
      min-width: 0;
      padding: 6px 7px;
      border: 1px solid #d8dbea;
      border-radius: 7px;
      background: #fff;
      color: #202237;
      font-weight: 400;
    }
    textarea { resize: vertical; }
    .row { display: grid; gap: 4px; align-items: center; }
    .sort-row { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) repeat(3, auto); }
    .condition-row { grid-template-columns: minmax(0, 1.4fr) minmax(42px, .5fr) minmax(0, 1fr) auto; }
    .color-row { grid-template-columns: minmax(0, 1fr) 72px auto; }
    .neutral-color-label { display: flex; align-items: center; gap: 4px; font-size: 12px; }
    input[type="color"] { height: 34px; padding: 4px; cursor: pointer; }
    .icon-button { min-width: 28px; padding: 4px 6px; }
    .add-button { color: #353990; font-weight: 600; }
    .rows:not(:empty) { margin-bottom: 6px; }
    .status { font-size: 12px; color: #555a74; }
    .status[data-error] { color: #a41931; }
  `,
  );

  const launcher = button(
    "Study sorter",
    () => togglePanel(true),
    "primary launcher",
  );
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "sorter-panel");
  const panel = element("section", "", "panel");
  panel.id = "sorter-panel";
  panel.setAttribute("aria-labelledby", "sorter-heading");
  panel.hidden = true;
  const heading = element("h2", "Study sorter");
  heading.id = "sorter-heading";
  const close = iconButton("×", "Close study sorter", () => togglePanel(false));
  const header = element("header");
  header.append(heading, close);
  const pickNotice = element("div", "", "pick-notice");
  const pickHint = element(
    "p",
    "Click text on the page to add it as a pattern.",
  );
  pickHint.setAttribute("role", "status");
  const cancelPick = button("Cancel", cancelPicking);
  pickNotice.append(pickHint, cancelPick);
  pickNotice.hidden = true;
  const content = element("div", "", "content");
  const footer = element("footer");
  const status = element("span", "", "status");
  status.setAttribute("role", "status");
  footer.append(status, button("Save settings", saveSettings, "primary"));
  panel.append(header, content, footer);
  shadow.append(launcher, panel, pickNotice);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      togglePanel(false);
    }
  });
  content.addEventListener("input", markUnsaved);
  content.addEventListener("change", markUnsaved);

  const defaultBox = element("details");
  const defaultBody = element("div", "", "default-sort");
  const defaultSummary = element("summary", "", "summary-line");
  const defaultCount = element("span", "", "summary-count");
  function updateDefaultCount(count) {
    defaultCount.textContent = "(" + count + ")";
  }
  let defaultSort = sortEditor(settings.defaultSort, updateDefaultCount);
  defaultSummary.append(
    element("span", "Default sorting", "summary-label"),
    defaultCount,
  );
  defaultBody.append(
    element(
      "p",
      "Used for studies with the same score. Rules can set their own priorities.",
      "hint",
    ),
    defaultSort.element,
  );
  defaultBox.append(defaultSummary, defaultBody);

  const colorBox = element("details");
  const colorSummary = element("summary", "", "summary-line");
  const swatches = element("span", "", "color-swatches");
  swatches.setAttribute("aria-hidden", "true");
  let colors = colorEditor(
    settings.colors ?? DEFAULT_SETTINGS.colors,
    refreshColorPreviews,
  );
  colorSummary.append(
    element("span", "Score colors", "summary-label"),
    swatches,
  );
  colorBox.append(colorSummary, colors.element);

  const settingsBox = element("details");
  settingsBox.append(element("summary", "Settings", "summary-line"));
  const settingToggles = Object.fromEntries(
    Object.entries(TOGGLE_LABELS).map(([key, text]) => {
      const input = element("input");
      input.type = "checkbox";
      input.checked = liveOptions[key];
      input.addEventListener("change", () => {
        liveOptions[key] = input.checked;
        scheduleUpdate();
      });
      const label = element("label", "", "setting-toggle");
      label.append(input, element("span", text));
      settingsBox.append(label);
      return [key, input];
    }),
  );
  const settingsFile = element("input");
  settingsFile.type = "file";
  settingsFile.accept = ".json,application/json";
  settingsFile.hidden = true;
  settingsFile.addEventListener("change", importSettings);
  shadow.append(settingsFile);
  let importRequest = 0;
  const settingsActions = element("div", "", "settings-actions");
  settingsActions.append(
    button("Export settings", exportSettings),
    button("Import settings", () => settingsFile.click()),
  );
  settingsBox.append(settingsActions);

  const rulesContainer = element("div", "", "rules");
  let rules = settings.rules.map(ruleEditor);
  const rulesHeader = element("div", "", "rules-header");
  const addRule = button(
    "+ Add rule",
    () => {
      const rule = ruleEditor({ score: 0 });
      rules.unshift(rule);
      rule.element.open = true;
      renderRules();
      rule.focus();
      markUnsaved();
    },
    "add-button",
  );
  rulesHeader.append(element("h3", "Scoring rules"), addRule);
  content.append(
    defaultBox,
    colorBox,
    settingsBox,
    rulesHeader,
    element(
      "p",
      "The first matching rule sets the score. Put more specific rules above broader ones.",
      "hint",
    ),
    element(
      "p",
      "Enter one name or publisher pattern per line. Use * for any text. Empty pattern fields match any value. Studies must meet every numeric condition.",
      "hint",
    ),
    rulesContainer,
  );

  function togglePanel(open) {
    if (!open) stopPicking();
    panel.hidden = !open;
    launcher.hidden = open;
    launcher.setAttribute("aria-expanded", String(open));
    if (open) refreshColorPreviews();
    (open ? close : launcher).focus();
  }

  function renderRules() {
    stopPicking();
    rulesContainer.replaceChildren();
    rules.forEach((rule, index) => {
      const move = (offset) => {
        moveItem(rules, index, index + offset);
        renderRules();
        rule.element.querySelector("summary").focus();
        markUnsaved();
      };
      rule.actions.replaceChildren(
        iconButton("↑", "Move rule up", () => move(-1), index === 0),
        iconButton(
          "↓",
          "Move rule down",
          () => move(1),
          index === rules.length - 1,
        ),
        button("Remove rule", () => {
          rules.splice(index, 1);
          renderRules();
          const nextRule = rules[Math.min(index, rules.length - 1)];
          (nextRule?.element.querySelector("summary") ?? addRule).focus();
          markUnsaved();
        }),
      );
      rulesContainer.append(rule.element);
    });
  }

  function refreshColorPreviews() {
    const levels = new Map();
    for (const level of colors.read()) {
      if (
        Number.isFinite(level.score) &&
        level.score !== 0 &&
        !levels.has(level.score)
      ) {
        levels.set(level.score, level);
      }
    }
    const orderedLevels = [...levels.values()].sort(
      (first, second) => first.score - second.score,
    );
    previewColorStops = compileColors(orderedLevels);
    const previewLevels = [...orderedLevels, { score: 0 }].sort(
      (first, second) => first.score - second.score,
    );
    swatches.replaceChildren(
      ...previewLevels.map(({ score, color }) => {
        const swatch = element("span", "", "color-swatch");
        swatch.title = "Score " + score + " · " + (color ?? "Neutral");
        const chip = element("span", "", "color-swatch-chip");
        if (color) {
          swatch.style.setProperty("border-color", color, "important");
          chip.style.setProperty("background-color", color, "important");
        }
        swatch.append(
          chip,
          element("span", String(score), "color-swatch-score"),
        );
        return swatch;
      }),
    );
    rules.forEach((rule) => rule.updateColor());
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.toggleAttribute("data-error", isError);
  }

  function markUnsaved() {
    showStatus("Unsaved changes");
  }

  function readValidSettingsDraft() {
    const invalidColor = colors.invalidInput();
    if (invalidColor) {
      colorBox.open = true;
      invalidColor.focus();
      showStatus("Each color needs a unique, nonzero score.", true);
      return null;
    }
    for (const rule of rules) {
      const invalid = rule.invalidInput();
      if (invalid) {
        rule.element.open = true;
        invalid.focus();
        showStatus(
          "Enter a valid score and threshold for each numeric condition.",
          true,
        );
        return null;
      }
      if (rule.missingMatch()) {
        rule.element.open = true;
        rule.focus();
        showStatus("Add a pattern or numeric condition to each rule.", true);
        return null;
      }
    }
    return {
      defaultSort: defaultSort.read(),
      ...Object.fromEntries(
        Object.entries(settingToggles).map(([key, input]) => [
          key,
          input.checked,
        ]),
      ),
      colors: colors.read(),
      rules: rules.map((rule) => rule.read()),
    };
  }

  function isValidSort(sort) {
    return (
      Array.isArray(sort) &&
      sort.every(
        (criterion) =>
          typeof criterion?.field === "string" &&
          Object.hasOwn(FIELDS, criterion.field) &&
          typeof criterion.direction === "string" &&
          Object.hasOwn(DIRECTIONS, criterion.direction),
      ) &&
      new Set(sort.map(({ field }) => field)).size === sort.length
    );
  }

  function isValidPatterns(patterns) {
    return (
      Array.isArray(patterns) &&
      patterns.every(
        (pattern) =>
          typeof pattern === "string" &&
          pattern.trim() &&
          !/[\r\n]/.test(pattern),
      )
    );
  }

  function isValidRule(rule) {
    return (
      Number.isFinite(rule?.score) &&
      isValidPatterns(rule.names) &&
      isValidPatterns(rule.publishers) &&
      Array.isArray(rule.conditions) &&
      rule.conditions.every(
        (condition) =>
          Number.isFinite(condition?.value) &&
          typeof condition.field === "string" &&
          Object.hasOwn(NUMERIC_FIELDS, condition.field) &&
          typeof condition.operator === "string" &&
          Object.hasOwn(OPERATORS, condition.operator),
      ) &&
      rule.names.length + rule.publishers.length + rule.conditions.length > 0 &&
      isValidSort(rule.sort)
    );
  }

  function parseSettingsFile(contents) {
    let file;
    try {
      file = JSON.parse(contents);
    } catch {
      throw new Error("The file is not valid JSON.");
    }

    const imported = file?.settings;
    if (
      file?.format !== SETTINGS_FORMAT ||
      file.version !== SETTINGS_FORMAT_VERSION ||
      !imported
    ) {
      throw new Error(
        "Choose a supported settings JSON exported by Study Sorter.",
      );
    }
    if (!isValidSort(imported.defaultSort)) {
      throw new Error("The file contains invalid default sorting.");
    }
    if (
      Object.keys(TOGGLE_LABELS).some(
        (key) => typeof imported[key] !== "boolean",
      )
    ) {
      throw new Error("The file contains invalid preferences.");
    }
    if (
      !Array.isArray(imported.colors) ||
      !imported.colors.every(
        (stop) =>
          Number.isFinite(stop?.score) &&
          stop.score !== 0 &&
          typeof stop.color === "string" &&
          /^#[\da-f]{6}$/i.test(stop.color),
      ) ||
      new Set(imported.colors.map(({ score }) => score)).size !==
        imported.colors.length
    ) {
      throw new Error("The file contains invalid score colors.");
    }
    if (!Array.isArray(imported.rules) || !imported.rules.every(isValidRule)) {
      throw new Error("The file contains invalid scoring rules.");
    }
    return imported;
  }

  function loadSettingsDraft(imported) {
    const newSort = sortEditor(imported.defaultSort, updateDefaultCount);
    defaultSort.element.replaceWith(newSort.element);
    defaultSort = newSort;

    const newColors = colorEditor(imported.colors, refreshColorPreviews);
    colors.element.replaceWith(newColors.element);
    colors = newColors;

    for (const [key, input] of Object.entries(settingToggles))
      input.checked = imported[key];
    rules = imported.rules.map(ruleEditor);
    renderRules();
    refreshColorPreviews();
  }

  function exportSettings() {
    const draft = readValidSettingsDraft();
    if (!draft) return;
    const contents =
      JSON.stringify(
        {
          format: SETTINGS_FORMAT,
          version: SETTINGS_FORMAT_VERSION,
          settings: draft,
        },
        null,
        2,
      ) + "\n";
    const url = URL.createObjectURL(
      new Blob([contents], { type: "application/json" }),
    );
    const download = element("a");
    download.href = url;
    download.download = "Study-Sorter-settings.json";
    download.hidden = true;
    shadow.append(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("Settings exported.");
  }

  async function importSettings() {
    const file = settingsFile.files?.[0];
    settingsFile.value = "";
    if (!file) return;
    const request = ++importRequest;

    try {
      const imported = parseSettingsFile(await file.text());
      if (request !== importRequest) return;
      loadSettingsDraft(imported);
      showStatus("Settings imported. Save settings to apply them.");
    } catch (error) {
      if (request === importRequest)
        showStatus(error.message || "Could not import settings.", true);
    }
  }

  function saveSettings() {
    const updatedSettings = readValidSettingsDraft();
    if (!updatedSettings) return;
    try {
      GM_setValue(SETTINGS_KEY, updatedSettings);
    } catch (error) {
      console.error("Study sorter could not save settings.", error);
      showStatus("Could not save your settings.", true);
      return;
    }
    settings = updatedSettings;
    for (const key of Object.keys(settingToggles))
      liveOptions[key] = settings[key];
    compiledRules = compileRules(settings.rules);
    colorStops = compileColors(settings.colors);
    showStatus("Settings saved.");
    scheduleUpdate();
  }

  renderRules();
  showStatus("");
  const observer = new MutationObserver((records) => {
    if (
      (isStudiesPage() && !panelHost.isConnected) ||
      records.some(affectsStudyPage)
    )
      scheduleUpdate();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "data-testid", "aria-label", "title", "hidden"],
  });
  window.addEventListener("urlchange", scheduleUpdate);
  window.addEventListener("popstate", scheduleUpdate);
  window.addEventListener(
    "pointerover",
    (event) => {
      if (textPick) highlightPickedText(getPickTarget(event)?.element ?? null);
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (textPick && !event.composedPath().includes(panelHost)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener("click", pickPageText, true);
  window.addEventListener(
    "keydown",
    (event) => {
      if (textPick && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelPicking();
      }
    },
    true,
  );
  updateStudies();
})();
