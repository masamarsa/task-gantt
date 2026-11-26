"use strict";

const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
const state = {
  view: "week", anchor: "", page: "timeline", allTasks: true,
  data: null, editing: null, editorMode: "view", loading: 0, saving: false,
};
const pageNames = { timeline: "タイムライン", tasks: "タスク一覧", stats: "期間統計" };
const dateKinds = { goal: "目標", plan: "予定", actual: "実績" };
const dateEdges = { start: "開始", end: "終了" };
const hours = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
const form = elements["task-form"];
const editor = elements.editor;
const resumeConfirmation = elements["resume-confirmation"];
const markdownFields = ["description", "approach"];
const dayLength = 24 * 60 * 60 * 1000;

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text, className, handler) {
  const element = node("button", className, text);
  element.type = "button";
  element.addEventListener("click", handler);
  return element;
}

function localDay() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tokyo",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return [parts.year, parts.month, parts.day].join("-");
}

const calendarDate = (date) => new Date(date + "T00:00:00Z");
const dayKey = (date) => date.toISOString().slice(0, 10);
const midnightJst = (date) => Date.parse(date + "T00:00:00+09:00");
const shortDate = (stamp) => stamp ? stamp.slice(0, 16).replace("T", " ").replaceAll("-", "/") : "—";
const asHours = (value) => value == null ? "—" : hours.format(value) + " 時間";
function delta(value, unit = "時間") {
  if (value == null) return "—";
  if (value === 0) return "0 " + unit;
  return (value > 0 ? "+" : "−") + hours.format(Math.abs(value)) + " " + unit;
}
function dateDelta(actual, baseline) {
  if (!actual || !baseline) return "—";
  const difference = Date.parse(actual) - Date.parse(baseline);
  const absolute = Math.floor(Math.abs(difference) / 60000);
  const days = Math.floor(absolute / 1440);
  const wholeHours = Math.floor(absolute / 60) % 24;
  const minutes = absolute % 60;
  const parts = [];
  if (days) parts.push(days + "日");
  if (wholeHours) parts.push(wholeHours + "時間");
  if (minutes || !parts.length) parts.push(minutes + "分");
  const prefix = absolute === 0 ? "" : difference > 0 ? "+" : "−";
  return prefix + parts.join(" ");
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "データを取得できませんでした。");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function load() {
  const iteration = ++state.loading;
  const query = new URLSearchParams({ view: state.view, date: state.anchor || localDay() });
  try {
    const data = await api("/api/dashboard?" + query);
    if (iteration !== state.loading) return false;
    state.data = data;
    state.anchor = data.period.anchor;
    setError(elements["page-error"], "");
    paint();
    return true;
  } catch (error) {
    if (iteration === state.loading) setError(elements["page-error"], error.message);
    return false;
  }
}

function setError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function periodLabel(start, end) {
  const first = start.replaceAll("-", "/");
  if (state.view === "day") return first;
  if (state.view === "month") return first.slice(0, 7);
  const last = calendarDate(end);
  last.setUTCDate(last.getUTCDate() - 1);
  const offset = last.getUTCFullYear() === Number(start.slice(0, 4)) ? 5 : 0;
  return first + " – " + dayKey(last).slice(offset).replaceAll("-", "/");
}

function navigatePeriod(direction) {
  const date = calendarDate(state.anchor || localDay());
  if (state.view === "month") {
    date.setUTCMonth(date.getUTCMonth() + direction, 1);
  } else {
    date.setUTCDate(date.getUTCDate() + (state.view === "week" ? 7 : 1) * direction);
  }
  if (date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9998) return;
  state.anchor = dayKey(date);
  void load();
}

function updatePeriodControls() {
  const isTaskList = state.page === "tasks";
  const allPeriods = isTaskList && state.allTasks;
  elements["period-navigation"].hidden = allPeriods;
  elements["all-periods"].hidden = !isTaskList;
  elements["all-periods"].setAttribute("aria-pressed", String(allPeriods));
  for (const control of document.querySelectorAll("[data-view]")) {
    control.setAttribute("aria-pressed", String(!allPeriods && control.dataset.view === state.view));
  }
}

function paint() {
  const { period, summary, statuses } = state.data;
  elements["range-label"].textContent = periodLabel(period.start, period.end);
  if (elements["status-filter"].options.length === 1) {
    for (const [key, label] of Object.entries(statuses)) {
      elements["status-filter"].add(new Option(label, key));
    }
  }
  renderMetrics(summary);
  if (state.page === "timeline") renderGantt(period, summary.now);
  if (state.page === "tasks") renderList();
  if (state.page === "stats") renderStatistics(summary);
}

function renderMetrics(summary) {
  elements.metrics.replaceChildren();
  for (const [label, amount, unit] of [
    ["期間内に開始", summary.started, "件"],
    ["期間内に終了", summary.finished, "件"],
    ["期間内の実績工数", hours.format(summary.actual_hours), "時間"],
    ["未終了（全体）", summary.open, "件"],
  ]) {
    const card = node("article", "metric");
    const value = node("div", "metric-value");
    value.append(node("strong", "", amount), node("span", "", unit));
    card.append(node("p", "metric-label", label), value);
    elements.metrics.append(card);
  }
}

function pill(task) {
  return node("span", "pill " + task.status, state.data.statuses[task.status]);
}

function statusSelect(task) {
  const select = node("select", "status-select pill " + task.status);
  select.setAttribute("aria-label", "「" + task.title + "」のステータス");
  select.dataset.taskId = task.id;
  select.disabled = state.saving;
  for (const status of [task.status, ...state.data.transitions[task.status]]) {
    select.add(new Option(state.data.statuses[status], status));
  }
  select.addEventListener("change", async () => {
    const status = select.value;
    select.value = task.status;
    const wasFocused = document.activeElement === select;
    const list = select.closest("#task-list, #gantt");
    await changeStatus(task, status);
    if (wasFocused && !select.isConnected && document.activeElement === document.body) {
      list.querySelector('.status-select[data-task-id="' + task.id + '"]')?.focus({ preventScroll: true });
    }
  });
  return select;
}

function taskLink(task) {
  const link = button(task.title, "task-link", () => openEditor(task));
  link.title = task.title;
  return link;
}

function emptyState(title, message, offerCreation = false) {
  const element = node("div", "empty");
  element.append(node("strong", "", title), node("p", "", message));
  if (offerCreation) element.append(button("最初のタスクを作成", "button subtle", () => openEditor()));
  return element;
}

function overlapsPeriod(left, right, start, end) {
  return left < end && (right > start || (left === start && right === start));
}

function renderGantt(period, now) {
  const chart = elements.gantt;
  const start = midnightJst(period.start);
  const end = midnightJst(period.end);
  const span = end - start;
  const isDay = state.view === "day";
  const columns = isDay ? 12 : span / dayLength;
  const today = localDay();
  const axis = [];
  for (let index = 0; index < columns; index++) {
    if (isDay) {
      axis.push({ label: String(index * 2).padStart(2, "0") + ":00" });
    } else {
      const date = calendarDate(period.start);
      date.setUTCDate(date.getUTCDate() + index);
      const monthView = state.view === "month";
      axis.push({
        label: monthView ? String(date.getUTCDate()) : date.getUTCMonth() + 1 + "/" + date.getUTCDate(),
        detail: weekdays[date.getUTCDay()],
        style: dayKey(date) === today ? "calendar-today" : [0, 6].includes(date.getUTCDay()) ? "weekend" : "",
      });
    }
  }

  function grid(labels) {
    const container = node("div", labels ? "gantt-cells" : "gantt-grid");
    if (!labels) container.setAttribute("aria-hidden", "true");
    for (const entry of axis) {
      const cell = node("span", entry.style, labels ? entry.label : undefined);
      if (labels && entry.detail) cell.append(node("small", "", entry.detail));
      container.append(cell);
    }
    return container;
  }

  function addBar(track, task, type, left, right, label, running = false) {
    if (!left && !right) return false;
    const a = Date.parse(left || right);
    const b = Date.parse(right || left);
    if (!overlapsPeriod(a, b, start, end)) return false;
    const min = ((Math.max(a, start) - start) / span) * 100;
    const max = ((Math.min(b, end) - start) / span) * 100;
    const point = a === b;
    const bar = button("", "gantt-bar " + type + (point ? " point" : "") + (running ? " running" : ""),
      () => openEditor(task));
    bar.style.left = point ? "clamp(0px, " + min + "%, calc(100% - 7px))" : min + "%";
    bar.style.width = (max - min) + "%";
    const range = (left ? shortDate(left) : "開始未入力") + " 〜 " + (right ? shortDate(right) : "終了未入力");
    bar.title = task.title + " · " + label + " · " + range;
    bar.setAttribute("aria-label", bar.title);
    track.append(bar);
    return true;
  }

  chart.replaceChildren();
  const inner = node("div");
  const minColumn = state.view === "month" ? 33 : 51;
  inner.style.minWidth = "calc(var(--task-column) + " + columns * minColumn + "px)";
  inner.style.setProperty("--columns", columns);
  const heading = node("div", "gantt-row gantt-head");
  heading.append(node("div", "gantt-title", "タスク"), grid(true));
  inner.append(heading);
  let visible = 0;
  for (const task of state.data.tasks) {
    const track = node("div", "gantt-track");
    track.append(grid(false));
    const goal = addBar(track, task, "goal", task.goal_start, task.goal_end, "目標");
    const plan = addBar(track, task, "plan", task.plan_start, task.plan_end, "予定");
    let actual = addBar(track, task, "actual actual-outline", task.actual_start, task.actual_end, "実績日時");
    for (const [left, right] of task.work_intervals) {
      const running = (task.status === "started" || task.status === "resumed") && !task.actual_end && right === now;
      actual = addBar(track, task, "actual", left, right, running ? "作業中" : "作業時間", running) || actual;
    }
    const git = task.git && addBar(track, task, "git", task.git.first_at, task.git.last_at, "Git参考");
    const undated = !Object.keys(dateKinds).some((key) => task[key + "_start"] || task[key + "_end"])
      && !task.git?.first_at;
    if (!goal && !plan && !actual && !git && !undated) continue;
    if (undated) track.append(node("span", "gantt-undated", "日時未入力"));
    visible++;
    const row = node("div", "gantt-row");
    const title = node("div", "gantt-title");
    title.append(taskLink(task), statusSelect(task));
    row.append(title, track);
    inner.append(row);
  }
  chart.append(inner);
  if (!visible) {
    const noTasks = !state.data.tasks.length;
    chart.append(emptyState(noTasks ? "タスクを作成しましょう" : "この期間に表示するタスクはありません",
      noTasks ? "日時を記録すると、ここに作業の流れが表示されます。" : "表示期間を変更するか、タスク一覧から日時を確認できます。",
      noTasks));
  }
}

function table(headers, rows) {
  const result = node("table");
  const head = result.createTHead().insertRow();
  for (const title of headers) {
    const cell = node("th", "", title);
    cell.scope = "col";
    head.append(cell);
  }
  const body = result.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      cell.append(value);
    }
  }
  return result;
}

function taskInPeriod(task, start, end) {
  const ranges = [
    [task.goal_start, task.goal_end], [task.plan_start, task.plan_end],
    [task.actual_start, task.actual_end], [task.git?.first_at, task.git?.last_at],
    ...task.work_intervals,
  ];
  return ranges.some(([left, right]) =>
    overlapsPeriod(Date.parse(left || right), Date.parse(right || left), start, end));
}

function renderList() {
  const container = elements["task-list"];
  const { tasks, period } = state.data;
  const start = midnightJst(period.start);
  const end = midnightJst(period.end);
  const keyword = elements.search.value.trim().toLocaleLowerCase("ja");
  const status = elements["status-filter"].value;
  const matches = tasks.filter((task) => (!status || task.status === status) &&
    (state.allTasks || taskInPeriod(task, start, end)) &&
    (!keyword || [task.title, task.description, task.approach, "#" + task.id, task.git?.ticket || ""]
      .some((field) => field.toLocaleLowerCase("ja").includes(keyword))));
  elements["task-count"].textContent = matches.length + " 件";
  if (!matches.length) {
    const noTasks = !tasks.length;
    container.replaceChildren(emptyState(noTasks ? "タスクがありません" : "一致するタスクがありません",
      noTasks ? "タスクを作成して進捗を記録できます。" : "期間、検索語、ステータスを変更してください。", noTasks));
    return;
  }
  container.replaceChildren(table(["題名", "ステータス", "予定終了", "実績終了", "実績工数"],
    matches.map((task) => [taskLink(task), statusSelect(task), shortDate(task.plan_end), shortDate(task.actual_end),
      task.actual_start || task.actual_hours != null ? asHours(task.actual_hours ?? task.tracked_hours) : "—"])));
}

function renderStatistics(summary) {
  const dates = node("div");
  const dateRows = Object.entries(summary.dates).map(([key, stats]) => {
    const [kind, edge] = key.split("_");
    return [dateKinds[kind] + dateEdges[edge], stats.count + " 件",
      stats.count ? stats.late + " 件" : "—", delta(stats.average_hours)];
  });
  dates.append(node("h3", "", "日時の差分"), table(["基準", "比較対象", "遅れ", "平均差分（実績 − 基準）"], dateRows));
  const effort = node("div");
  const effortRows = [["予定工数", summary.plan], ["AI予想工数", summary.ai]].map(([label, stats]) => [
    label, stats.count + " 件", stats.count ? asHours(stats.expected) : "—",
    stats.count ? asHours(stats.actual) : "—", stats.count ? delta(stats.difference) : "—",
  ]);
  effort.append(node("h3", "", "工数の差分"), table(["基準", "終了タスク", "基準工数", "実績工数", "差分（実績 − 基準）"], effortRows));
  elements.statistics.replaceChildren(dates, effort);
}

const datePicker = elements["date-picker"];
const calendarDays = elements["calendar-days"];
const calendarDayLabel = new Intl.DateTimeFormat("ja-JP", { dateStyle: "full", timeZone: "UTC" });
const dateInputs = new Map();
const dateValue = (value) => value?.slice(0, 19) || "";
const twoDigits = (number) => String(number).padStart(2, "0");
let activeDateField;
let pickedDay;
let calendarCursor;
let pickerMin;
let pickerMax;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function pickerAllowsDay(day) {
  return day >= pickerMin.slice(0, 10) && day <= pickerMax.slice(0, 10);
}

function setDateField(name, value) {
  const field = dateInputs.get(name);
  field.value = value;
  field.control.textContent = value ? shortDate(value) : "日時を選択";
  field.control.dataset.empty = String(!value);
}

function renderDateCalendar(focusDay = false) {
  const month = calendarCursor.slice(0, 7);
  const first = calendarDate(month + "-01");
  const title = first.getUTCFullYear() + "年 " + (first.getUTCMonth() + 1) + "月";
  if (elements["calendar-month"].textContent !== title) elements["calendar-month"].textContent = title;
  elements["calendar-previous"].setAttribute("aria-disabled", String(month === pickerMin.slice(0, 7)));
  elements["calendar-next"].setAttribute("aria-disabled", String(month === pickerMax.slice(0, 7)));
  const today = localDay();
  elements["calendar-today"].disabled = !pickerAllowsDay(today);
  const firstOffset = (first.getUTCDay() + 6) % 7;
  const rows = [];
  let focusedControl;
  for (let week = 0; week < 6; week++) {
    const row = node("div", "calendar-row");
    row.setAttribute("role", "row");
    for (let weekday = 0; weekday < 7; weekday++) {
      const cell = node("div", "calendar-cell");
      cell.setAttribute("role", "gridcell");
      row.append(cell);
      const date = new Date(first.getTime() + (week * 7 + weekday - firstOffset) * dayLength);
      if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) continue;
      const key = dayKey(date);
      const day = node("button", "calendar-day", date.getUTCDate());
      day.type = "button";
      day.dataset.date = key;
      day.disabled = !pickerAllowsDay(key);
      day.tabIndex = key === calendarCursor ? 0 : -1;
      day.setAttribute("aria-label", calendarDayLabel.format(date));
      cell.setAttribute("aria-selected", String(key === pickedDay));
      if (key === today) day.setAttribute("aria-current", "date");
      if (key.slice(0, 7) !== month) day.classList.add("outside-month");
      if (key === calendarCursor) focusedControl = day;
      cell.append(day);
    }
    rows.push(row);
  }
  calendarDays.replaceChildren(...rows);
  if (focusDay) focusedControl.focus({ preventScroll: true });
}

function offsetCalendarMonth(date, months) {
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months, 1);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, end.getUTCDate()));
}

function browseCalendar(months) {
  const date = calendarDate(calendarCursor);
  offsetCalendarMonth(date, months);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
  const key = dayKey(date);
  const month = key.slice(0, 7);
  if (month < pickerMin.slice(0, 7) || month > pickerMax.slice(0, 7)) return;
  calendarCursor = clamp(key, pickerMin.slice(0, 10), pickerMax.slice(0, 10));
  renderDateCalendar();
}

function pickDate(date) {
  pickedDay = calendarCursor = date;
  renderDateCalendar(true);
  updatePickerTimeRange();
}

calendarDays.addEventListener("click", (event) => {
  if (event.target.dataset.date) pickDate(event.target.dataset.date);
});

calendarDays.addEventListener("keydown", (event) => {
  if (!event.target.dataset.date) return;
  const date = calendarDate(event.target.dataset.date);
  const dayOffsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (event.key in dayOffsets) {
    date.setUTCDate(date.getUTCDate() + dayOffsets[event.key]);
  } else if (event.key === "PageUp" || event.key === "PageDown") {
    offsetCalendarMonth(date, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
  } else {
    return;
  }
  event.preventDefault();
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
  const next = clamp(dayKey(date), pickerMin.slice(0, 10), pickerMax.slice(0, 10));
  if (next === calendarCursor) return;
  calendarCursor = next;
  renderDateCalendar(true);
});

function createTimeWheel(wheel, count, onChange) {
  const options = Array.from({ length: count }, (_, index) => {
    const option = node("div", "time-option", twoDigits(index));
    option.id = wheel.id + "-" + index;
    option.dataset.index = index;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    return option;
  });
  wheel.append(...options);
  let selected = -1;
  let first = 0;
  let last = count - 1;
  const rowHeight = () => options[first].offsetHeight;
  const value = () => rowHeight() ? clamp(first + Math.round(wheel.scrollTop / rowHeight()), first, last) : first;

  function highlight() {
    if (!rowHeight()) return;
    const next = value();
    if (next === selected) return;
    options[selected]?.setAttribute("aria-selected", "false");
    selected = next;
    options[selected].setAttribute("aria-selected", "true");
    wheel.setAttribute("aria-activedescendant", options[selected].id);
    onChange?.();
  }

  function setValue(index) {
    wheel.scrollTop = (clamp(index, first, last) - first) * rowHeight();
    highlight();
  }

  function setRange(min, max) {
    if (min === first && max === last) return;
    const previous = value();
    first = min;
    last = max;
    for (const [index, option] of options.entries()) option.hidden = index < first || index > last;
    setValue(previous);
  }

  wheel.addEventListener("scroll", highlight);
  wheel.addEventListener("click", (event) => {
    if (event.target.dataset.index === undefined) return;
    setValue(Number(event.target.dataset.index));
    wheel.focus({ preventScroll: true });
  });
  wheel.addEventListener("keydown", (event) => {
    const keys = { ArrowUp: value() - 1, ArrowDown: value() + 1, Home: first, End: last };
    if (!(event.key in keys)) return;
    event.preventDefault();
    setValue(keys[event.key]);
  });
  return { value, setValue, setRange };
}

const hourWheel = createTimeWheel(elements["picker-hour"], 24, updatePickerMinuteRange);
const minuteWheel = createTimeWheel(elements["picker-minute"], 60);

function updatePickerMinuteRange() {
  const hour = pickedDay + "T" + twoDigits(hourWheel.value());
  const first = pickerMin.startsWith(hour) ? Number(pickerMin.slice(14, 16)) : 0;
  const last = pickerMax.startsWith(hour) ? Number(pickerMax.slice(14, 16)) : 59;
  minuteWheel.setRange(first, last);
}

function updatePickerTimeRange() {
  const first = pickerMin.startsWith(pickedDay) ? Number(pickerMin.slice(11, 13)) : 0;
  const last = pickerMax.startsWith(pickedDay) ? Number(pickerMax.slice(11, 13)) : 23;
  hourWheel.setRange(first, last);
  updatePickerMinuteRange();
}

function openDatePicker(name) {
  if (state.saving) return;
  const isPlan = name.startsWith("plan_");
  const min = isPlan ? dateInputs.get("goal_start").value.slice(0, 16) : "";
  const max = isPlan ? dateInputs.get("goal_end").value.slice(0, 16) : "";
  if (min && max && min > max) {
    setError(elements["form-error"], "目標終了日時は開始日時以降にしてください。");
    editor.querySelector(".editor-content").scrollTop = 0;
    return;
  }
  pickerMin = min || "0001-01-01T00:00";
  pickerMax = max || "9999-12-31T23:59";
  const rangeLabel = elements["picker-range"];
  rangeLabel.hidden = !(min || max);
  rangeLabel.textContent = min && max ? shortDate(min) + " 〜 " + shortDate(max)
    : min ? shortDate(min) + " 以降" : max ? shortDate(max) + " 以前" : "";
  activeDateField = name;
  const field = dateInputs.get(name);
  const initial = clamp(field.value.slice(0, 16) || localDay() + "T00:00", pickerMin, pickerMax);
  pickedDay = calendarCursor = initial.slice(0, 10);
  elements["picker-title"].textContent = field.label;
  elements["picker-clear"].disabled = !field.value;
  renderDateCalendar();
  datePicker.showModal();
  datePicker.querySelector(".picker-content").scrollTop = 0;
  updatePickerTimeRange();
  hourWheel.setValue(Number(initial.slice(11, 13)));
  minuteWheel.setValue(Number(initial.slice(14, 16)));
  calendarDays.querySelector('[tabindex="0"]').focus({ preventScroll: true });
}

elements["calendar-previous"].addEventListener("click", () => browseCalendar(-1));
elements["calendar-next"].addEventListener("click", () => browseCalendar(1));
elements["calendar-today"].addEventListener("click", () => pickDate(localDay()));
elements["picker-close"].addEventListener("click", () => datePicker.close());
elements["picker-cancel"].addEventListener("click", () => datePicker.close());
elements["picker-clear"].addEventListener("click", () => {
  setDateField(activeDateField, "");
  datePicker.close();
});
elements["picker-apply"].addEventListener("click", () => {
  updatePickerMinuteRange();
  const minute = pickedDay + "T" + twoDigits(hourWheel.value()) + ":" + twoDigits(minuteWheel.value());
  // Keep the precision of an existing timestamp when the selected minute is unchanged.
  const existing = [dateInputs.get(activeDateField).value, dateValue(state.editing?.[activeDateField])]
    .find((value) => value.slice(0, 16) === minute);
  setDateField(activeDateField, existing || minute + ":00");
  datePicker.close();
});

const dateFields = node("div", "field-grid");
for (const [kind, kindLabel] of Object.entries(dateKinds)) {
  for (const [edge, edgeLabel] of Object.entries(dateEdges)) {
    const name = kind + "_" + edge;
    const field = node("div", "date-field");
    const label = node("span", "", kindLabel + edgeLabel + "日時");
    const labelId = name.replace("_", "-") + "-label";
    const control = button("", "date-trigger", () => openDatePicker(name));
    label.id = labelId;
    control.id = name.replace("_", "-");
    control.setAttribute("aria-labelledby", labelId + " " + control.id);
    control.setAttribute("aria-haspopup", "dialog");
    control.setAttribute("aria-controls", datePicker.id);
    dateInputs.set(name, { control, label: label.textContent });
    setDateField(name, "");
    field.append(label, control);
    dateFields.append(field);
  }
}
elements["date-fields"].append(dateFields);

function taskComparison(task) {
  const panel = elements["task-comparison"];
  const rows = [
    ["目標", dateDelta(task.actual_start, task.goal_start), dateDelta(task.actual_end, task.goal_end)],
    ["予定", dateDelta(task.actual_start, task.plan_start), dateDelta(task.actual_end, task.plan_end)],
  ];
  const measured = task.actual_hours ?? (task.actual_start ? task.tracked_hours : null);
  const effortRows = [["予定工数", task.plan_hours], ["AI予想工数", task.ai_hours]].map(([label, expected]) => [
    label, asHours(expected), asHours(measured),
    expected == null || measured == null ? "—" : delta(Math.round((measured - expected) * 100) / 100),
  ]);
  panel.replaceChildren(node("h3", "", "実績との差分"),
    table(["基準", "開始（実績 − 基準）", "終了（実績 − 基準）"], rows),
    table(["工数", "基準", "実績", "差分"], effortRows));
}

function showGitReference(task) {
  const reference = elements["git-reference"];
  reference.replaceChildren(node("h3", "", "Gitコミットの参考日時"));
  if (!task.git) {
    reference.append(node("p", "helper", "未連携。git_reference.py からタスク #" + task.id + " に取り込めます。"));
    return;
  }
  const list = node("dl", "reference-data");
  for (const [label, value] of [
    ["リポジトリ", task.git.repository], ["チケット", task.git.ticket],
    ["一致したコミット", task.git.commit_count + " 件"],
    ["最初の日時", shortDate(task.git.first_at) + (task.git.first_hash ? " · " + task.git.first_hash.slice(0, 10) : "")],
    ["最後の日時", shortDate(task.git.last_at) + (task.git.last_hash ? " · " + task.git.last_hash.slice(0, 10) : "")],
  ]) {
    list.append(node("dt", "", label), node("dd", "", value));
  }
  reference.append(list, node("p", "helper", "コミット日時は参考情報です。開始・終了の実績はフォームで管理します。"));
}

function renderDetailValues(list, values) {
  list.replaceChildren(...values.map(([label, value]) => {
    const group = node("div");
    group.append(node("dt", "", label), node("dd", "", value));
    return group;
  }));
}

async function renderTaskMarkdown(task) {
  const source = {};
  const errorPanel = elements["task-markdown-error"];
  setError(errorPanel, "");
  for (const field of markdownFields) {
    const output = elements["task-" + field];
    output.classList.add("markdown-source");
    output.textContent = task[field] || "未入力";
    if (task[field]) source[field] = task[field];
  }
  if (!Object.keys(source).length) return;
  const isCurrentView = () => editor.open && state.editing === task && state.editorMode === "view";
  try {
    const rendered = await send("POST", "/api/markdown", source);
    if (!isCurrentView()) return;
    const fields = Object.keys(source);
    if (fields.some((field) => typeof rendered[field] !== "string")) {
      throw new Error("Markdown の取得結果が正しくありません。");
    }
    for (const field of fields) {
      const output = elements["task-" + field];
      output.classList.remove("markdown-source");
      // The Markdown endpoint escapes raw HTML and validates link destinations.
      output.innerHTML = rendered[field];
    }
  } catch {
    if (isCurrentView()) setError(errorPanel, "Markdown を表示できなかったため、入力されたテキストを表示しています。");
  }
}

function renderTaskDetails(task) {
  renderDetailValues(elements["task-view-dates"], [...dateInputs].map(([name, field]) =>
    [field.label, shortDate(task[name])]));
  renderDetailValues(elements["task-view-hours"], [
    ["予定工数", asHours(task.plan_hours)],
    ["AI予想工数", asHours(task.ai_hours)],
    ["実績工数", asHours(task.actual_hours ?? (task.actual_start ? task.tracked_hours : null))],
  ]);
  void renderTaskMarkdown(task);
}

function updateMarkdownFields() {
  for (const field of markdownFields) {
    const value = form.elements[field].value.trim();
    const control = elements["edit-" + field];
    control.dataset.empty = String(!value);
    control.firstElementChild.textContent = value || "Markdown を入力";
  }
}

function openEditor(task = null, mode = task ? "view" : "edit") {
  if (state.saving && !editor.open) return;
  state.editing = task;
  state.editorMode = mode;
  const editing = mode === "edit";
  elements["editor-title"].textContent = task ? task.title : "タスクを作成";
  elements["editor-meta"].textContent = task ? "タスク #" + task.id : "";
  elements["task-view"].hidden = editing;
  elements["task-edit-fields"].hidden = !editing;
  elements["edit-task"].hidden = editing;
  elements.save.hidden = !editing;
  elements.cancel.textContent = task && editing ? "キャンセル" : "閉じる";
  form.reset();
  for (const name of dateInputs.keys()) setDateField(name, dateValue(task?.[name]));
  setError(elements["form-error"], "");
  elements["insert-tracked-hours"].hidden = !task?.actual_start;
  elements["tracked-help"].textContent = task?.actual_start
    ? "保存済みの実績日時と保留・再開の記録から計算します。"
    : "空欄の実績工数は作業時間から自動集計します。";
  const statusPanel = elements["task-state"];
  statusPanel.replaceChildren();
  statusPanel.hidden = !task;
  elements["task-comparison"].hidden = !task;
  elements["git-reference"].hidden = !task;
  if (task) {
    for (const field of form.elements) {
      if (field.name) field.value = task[field.name] ?? "";
    }
    statusPanel.append(pill(task));
    for (const status of state.data.transitions[task.status]) {
      statusPanel.append(button(state.data.statuses[status], "button subtle", () => changeStatus(task, status)));
    }
    taskComparison(task);
    showGitReference(task);
  }
  if (editing) updateMarkdownFields();
  else renderTaskDetails(task);
  if (!editor.open) editor.showModal();
  editor.querySelector(".editor-content").scrollTop = 0;
  (editing ? form.elements.title : elements["editor-title"]).focus({ preventScroll: true });
}

function formValues() {
  const values = Object.fromEntries(new FormData(form));
  for (const [name, field] of dateInputs) values[name] = field.value;
  return values;
}

function editedFormFields(values, task) {
  return Object.keys(values).filter((key) =>
    values[key] !== (dateInputs.has(key) ? dateValue(task?.[key]) : String(task?.[key] ?? "")));
}

function send(method, url, data) {
  return api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

function saving(active) {
  state.saving = active;
  elements.save.disabled = active;
  for (const control of document.querySelectorAll("#task-state button, .status-select, #edit-task, #insert-tracked-hours, .markdown-field")) {
    control.disabled = active;
  }
}

function confirmResume(task) {
  elements["resume-task"].textContent = task.title;
  elements["resume-guide"].textContent = task.status === "finished"
    ? "前回までの作業時間を引き継ぎ、実績終了日時を空欄にします。現在時刻から作業時間の計測を再開します。"
    : "保留するまでの作業時間を引き継ぎ、現在時刻から計測を再開します。";
  resumeConfirmation.returnValue = "";
  resumeConfirmation.showModal();
  return new Promise((resolve) => {
    resumeConfirmation.addEventListener("close", () => resolve(resumeConfirmation.returnValue === "resume"), { once: true });
  });
}

function refreshEditorTask(task) {
  if (!editor.open || state.editing !== task) return;
  const updated = state.data.tasks.find((item) => item.id === task.id);
  if (!updated) return;
  if (state.editorMode === "edit") {
    const draft = formValues();
    const changed = editedFormFields(draft, task);
    openEditor(updated, "edit");
    for (const field of changed) {
      if (dateInputs.has(field)) setDateField(field, draft[field]);
      else form.elements[field].value = draft[field];
    }
    updateMarkdownFields();
  } else {
    openEditor(updated);
  }
}

async function changeStatus(task, status) {
  if (state.saving || resumeConfirmation.open || task.status === status) return;
  const inEditor = editor.open && state.editing === task;
  const errorPanel = elements[inEditor ? "form-error" : "page-error"];
  const statusField = status === "started" ? "actual_start"
    : status === "finished" || task.status === "finished" ? "actual_end" : "";
  if (inEditor && state.editorMode === "edit" && editedFormFields(formValues(), task).includes(statusField)) {
    setError(errorPanel, "変更した実績日時を先に保存するか、日時を元に戻してください。");
    return;
  }
  if (status === "resumed" && !(await confirmResume(task))) return;

  setError(errorPanel, "");
  saving(true);
  try {
    await send("POST", "/api/tasks/" + task.id + "/status", { status, revision: task.revision });
    if (!(await load())) {
      setError(errorPanel, "ステータスを更新しました。最新の表示を確認するには画面を開き直してください。");
      return;
    }
    if (inEditor) refreshEditorTask(task);
    toast("ステータスを更新しました。");
  } catch (error) {
    const conflict = error.status === 409;
    const refreshed = (!inEditor || conflict) && await load();
    if (inEditor && refreshed) refreshEditorTask(task);
    setError(errorPanel, conflict && refreshed
      ? "別の操作でタスクが更新されたため、最新の状態を読み込みました。内容を確認してから、もう一度操作してください。"
      : error.message);
  } finally {
    saving(false);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.saving || state.editorMode !== "edit") return;
  const task = state.editing;
  const payload = formValues();
  if (task) payload.revision = task.revision;
  const errorPanel = elements["form-error"];
  setError(errorPanel, "");
  saving(true);
  try {
    await send(task ? "PUT" : "POST", task ? "/api/tasks/" + task.id : "/api/tasks", payload);
    if (task) {
      const refreshed = await load();
      const updated = refreshed && state.data.tasks.find((item) => item.id === task.id);
      try {
        openEditor(updated || await api("/api/tasks/" + task.id));
      } catch {
        setError(errorPanel, "タスクを保存しました。最新の表示を確認するには画面を開き直してください。");
        return;
      }
    } else {
      editor.close();
      await load();
    }
    toast(task ? "タスクを保存しました。" : "タスクを作成しました。");
  } catch (error) {
    if (task && error.status === 409 && await load()) {
      refreshEditorTask(task);
      setError(errorPanel, "最新のタスクを読み込みました。編集内容を確認してから、もう一度保存してください。");
    } else {
      setError(errorPanel, error.message);
    }
  } finally {
    saving(false);
  }
});

elements["insert-tracked-hours"].addEventListener("click", async () => {
  const task = state.editing;
  if (state.saving || state.editorMode !== "edit" || !task?.actual_start) return;
  const actualDatesMatch = (saved) => ["actual_start", "actual_end"].every((name) =>
    dateInputs.get(name).value === dateValue(saved[name]));
  const errorPanel = elements["form-error"];
  if (!actualDatesMatch(task)) {
    setError(errorPanel, "実績日時を保存してから、計測工数を入力してください。");
    return;
  }
  setError(errorPanel, "");
  saving(true);
  try {
    const latest = await api("/api/tasks/" + task.id);
    if (!actualDatesMatch(latest)) {
      if (await load()) refreshEditorTask(task);
      setError(errorPanel, "実績日時が更新されました。日時を確認してから、もう一度操作してください。");
      return;
    }
    const input = form.elements.actual_hours;
    if (latest.tracked_hours > Number(input.max)) {
      setError(errorPanel, "計測工数が入力できる上限を超えています。");
      return;
    }
    input.value = latest.tracked_hours;
    input.focus();
  } catch (error) {
    setError(errorPanel, error.message);
  } finally {
    saving(false);
  }
});

for (const field of markdownFields) {
  const input = form.elements[field];
  input.addEventListener("input", updateMarkdownFields);
  elements["edit-" + field].addEventListener("click", (event) => {
    openMarkdownEditor(input, elements[field + "-label"].textContent, event.currentTarget);
  });
}

function promptText(mode) {
  const fields = formValues();
  const task = state.editing;
  const tasksUrl = window.location.origin + "/api/tasks";
  const taskUrl = tasksUrl + "/" + (task?.id ?? "{id}");
  const supplied = {
    task_id: task?.id ?? null,
    revision: task?.revision ?? null,
    external_ticket: task?.git?.ticket ?? null,
    status: task ? state.data.statuses[task.status] : "未開始",
    edited_fields: editedFormFields(fields, task),
    fields,
  };
  const instructions = mode === "create" ? [
    "タスク情報と対象リポジトリを参考に、チケットの新規記入案を日本語で作成してください。",
    "題名、対応内容、対応方針、受け入れ条件、AI予想工数（時間）、見積もりの前提、確認事項を Markdown で出力してください。",
    "未確認の仕様や日時は「要確認」と明示してください。",
  ] : [
    "タスク情報、既存チケット、作業差分を参考に、チケットの更新案を日本語で作成してください。",
    "完了した対応、残作業、保留理由、テスト結果、次のアクション、見積もりの変更があれば根拠を Markdown で記載してください。",
    "確認済みの事実を記載し、実績日時・実績工数が不明な場合は「要確認」としてください。",
  ];
  const lookup = task ? `GET ${taskUrl} で保存済みのタスクを取得してください。`
    : `既存のタスクIDが分かる場合は GET ${taskUrl} の {id} に代入して取得してください。`;
  const create = mode === "create" && !task ? [
    `Task Gantt に新規作成する場合は POST ${tasksUrl} に title と確定した項目を送ってください。`,
  ] : [];
  return [
    ...instructions,
    "外部チケットとリポジトリは参照に使い、貼り付け用の案を返してください。",
    "", "【Task Gantt API】",
    lookup,
    "取得できた場合は最新のデータにフォームの edited_fields に含まれる項目を重ねて案を作成してください。取得できない場合はフォームを使い、その旨を伝えてください。",
    "Task Gantt への保存も依頼された場合だけ、次の書き込み操作を行ってください。",
    ...create,
    `既存タスクの更新は、GET で取得した revision と指定された変更項目だけを PATCH ${taskUrl} に送ってください。更新対象のIDが不明なら確認してください。`,
    "書き込みは Content-Type: application/json を指定してください。日時は日本時間の YYYY-MM-DDTHH:MM[:SS] 形式、工数は時間単位です。",
    "フォームに revision があり、取得した値と異なる場合は、保存前に上書きする項目を利用者に確認してください。409 が返った場合は再取得して同様に確認してください。",
    "保存を実行した場合は結果とタスクIDを伝えてください。",
    "", "【フォーム情報｜日時は日本時間】", JSON.stringify(supplied, null, 2),
  ].join("\n");
}

async function copy(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // An HTTP connection or denied clipboard permission can require the selection fallback.
    }
  }
  const area = node("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.cssText = "position:fixed;left:-1000px;top:0";
  const previous = document.activeElement;
  editor.append(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new Error("クリップボードにコピーできませんでした。");
  } finally {
    area.remove();
    previous?.focus();
  }
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  const target = editor.open ? editor : document.body;
  target.append(elements.toast);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2800);
}

document.querySelectorAll("[data-prompt]").forEach((item) => {
  item.addEventListener("click", async () => {
    try {
      await copy(promptText(item.dataset.prompt));
      toast("プロンプトをコピーしました。");
    } catch (error) {
      setError(elements["form-error"], error.message);
    }
  });
});

document.querySelectorAll("[data-page]").forEach((item) => {
  item.addEventListener("click", () => {
    state.page = item.dataset.page;
    for (const control of document.querySelectorAll("[data-page]")) {
      if (control === item) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    }
    for (const page of Object.keys(pageNames)) byId(page + "-page").hidden = page !== state.page;
    elements["page-title"].textContent = pageNames[state.page];
    elements.breadcrumb.textContent = pageNames[state.page];
    elements.metrics.hidden = state.page === "tasks";
    updatePeriodControls();
    if (state.data) paint();
    if (state.page === "stats") void load();
  });
});

document.querySelectorAll("[data-view]").forEach((item) => {
  item.addEventListener("click", () => {
    if (state.page === "tasks") state.allTasks = false;
    state.view = item.dataset.view;
    updatePeriodControls();
    void load();
  });
});

elements["all-periods"].addEventListener("click", () => {
  state.allTasks = true;
  updatePeriodControls();
  if (state.data) renderList();
});

elements["create-task"].addEventListener("click", () => openEditor());
elements["edit-task"].addEventListener("click", () => openEditor(state.editing, "edit"));
elements["editor-close"].addEventListener("click", () => { if (!state.saving) editor.close(); });
elements.cancel.addEventListener("click", () => {
  if (state.saving) return;
  if (state.editorMode === "edit" && state.editing) openEditor(state.editing);
  else editor.close();
});
editor.addEventListener("cancel", (event) => { if (state.saving) event.preventDefault(); });
editor.addEventListener("close", () => { elements.toast.hidden = true; });
elements.previous.addEventListener("click", () => navigatePeriod(-1));
elements.next.addEventListener("click", () => navigatePeriod(1));
elements.today.addEventListener("click", () => { state.anchor = localDay(); void load(); });
elements.search.addEventListener("input", () => { if (state.data) renderList(); });
elements["status-filter"].addEventListener("change", () => { if (state.data) renderList(); });

void load();
setInterval(() => {
  if (!document.hidden && !editor.open && !resumeConfirmation.open && !state.saving) void load();
}, 60000);
