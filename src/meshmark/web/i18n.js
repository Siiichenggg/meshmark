/* Every string the user sees, in both languages.
 *
 * Both languages are complete tables rather than a base language plus overrides.
 * An override table lets a missing key fall through to the other language and
 * look like a translation nobody got to, which is indistinguishable from a bug;
 * `missingKeys()` below makes the difference checkable, and a test calls it.
 *
 * Object class names do NOT live here. They come from the class preset, which is
 * the thing a user swaps to annotate a warehouse instead of an operating room.
 */

export const STRINGS = {
  en: {
    'lang.other': '中文',
    'add.title': 'Add object',
    'add.mode.on': 'Add mode: ON',
    'add.mode.off': 'Add mode: off',
    'add.hint': 'While on, <b>every click creates one object</b> of the chosen class, in either view.',
    'routes.title': 'Routes',
    'routes.mode.on': 'Draw route: ON',
    'routes.mode.off': 'Draw route: off',
    'routes.undo': 'Undo point',
    'routes.new': '+ New route',
    'routes.delete': 'Delete route',
    'routes.rename': 'Rename',
    'routes.hint': 'Turn on, then click the floor in order to trace a path.',
    'routes.info': '{n} waypoints, {len} m total (green = start)',
    'routes.recovered': ' · recovered from {key}',
    'routes.namePrompt': 'Name for this route:',
    'routes.confirmDelete': 'Delete route "{name}" and its {n} waypoints?',
    'routes.none': 'No routes yet.',
    'markers.legend': '<span class="swatch ref"></span> pink = a marker: drawn, never editable',
    'list.title': 'Objects',
    'list.showRefs': 'show references',
    'list.all': 'All',
    'list.refs': 'Reference',
    'list.added': 'Added',
    'list.empty': '(nothing in this group yet)',
    'list.progress': 'Reference {done}/{total}',
    'list.progressAdded': ' · added {n}',
    'io.export': 'Export JSON',
    'io.import': 'Load',
    'io.reset': 'Clear all',
    'io.autosave': 'Saved in this browser automatically; a refresh does not lose it.',
    'io.confirmReset': 'Clear every annotation and route for this scene?',
    'io.badJson': 'That is not valid JSON: {err}',
    'io.noCoords': 'Loaded {total} objects, but not one of them has a position — this is most likely an export that was never annotated.',
    'io.loaded': 'Loaded {n} annotations with positions.',
    'view.mode3d': '3D',
    'view.cut': 'Cut above',
    'view.frame': 'Frame target (F)',
    'view.loading': 'Loading the mesh…',
    'view.topdown': 'Rendering the top-down view…',
    'view.failed': 'Could not load the mesh: {err}',
    'view.baseline': 'baseline {baseline}',
    'view.noTargets': 'no reference file',
    'topdown.title': 'Top-down (click, drag)',
    'topdown.scale': '{mm} mm/pixel',
    'topdown.stale': 'view is for cut height {h} m — release the slider to re-render',
    'obj.classLabel': 'Class (editable)',
    'obj.classChanged': 'Class changed: {from} → {to}',
    'obj.original': 'was {label}',
    'obj.declared': 'reference radius {r} m',
    'obj.w': 'W', 'obj.d': 'D', 'obj.h': 'H',
    'obj.yaw': 'Yaw',
    'obj.confirm': 'Reference is right',
    'obj.absent': 'Nothing here',
    'obj.clear': 'Clear',
    'obj.prev': '← Previous',
    'obj.next': 'Next (Enter) →',
    'obj.note': 'Note (e.g. this is a blue linen trolley, not a bin)',
    'status.pending': 'not done',
    'status.confirmed': 'reference right',
    'status.corrected': 'corrected',
    'status.absent': 'nothing here',
    'status.added': 'added',
    'read.status': 'status',
    'read.reference': 'reference',
    'read.annotated': 'annotated',
    'read.offset': 'offset',
    'read.floor': 'floor',
    'help.title': 'Controls',
    'help.body':
      '<b>3D:</b> left drag = orbit · right drag = pan · wheel = zoom<br>' +
      '<b>single click</b> on the mesh = put the target there<br>' +
      '<b>Top-down:</b> click = set centre · drag inside = move · drag a corner = resize<br>' +
      '<b>Arrow keys</b> = 1 cm (Shift = 10 cm) · <b>Enter</b> = next<br>' +
      '<b>Del</b> = delete the current added object (reference targets cannot be deleted, only marked absent)',
  },
  zh: {
    'lang.other': 'EN',
    'add.title': '新增物体',
    'add.mode.on': '新增模式：开',
    'add.mode.off': '新增模式：关',
    'add.hint': '开启后，在任一视图里<b>每点一下就新建一个</b>所选类别的物体。',
    'routes.title': '路径',
    'routes.mode.on': '画路径：开',
    'routes.mode.off': '画路径：关',
    'routes.undo': '撤销点',
    'routes.new': '+ 新增路径',
    'routes.delete': '删除本条',
    'routes.rename': '改名',
    'routes.hint': '开启后依次点击地面，画出要走的路线。',
    'routes.info': '{n} 个路径点，总长 {len} m（绿点 = 起点）',
    'routes.recovered': '　· 已从旧存档 {key} 恢复',
    'routes.namePrompt': '这条路径叫什么：',
    'routes.confirmDelete': '删除路径「{name}」及其 {n} 个路径点？',
    'routes.none': '还没有路径。',
    'markers.legend': '<span class="swatch ref"></span> 粉色 = 标记：只画出来，不可编辑',
    'list.title': '物体列表',
    'list.showRefs': '显示参考',
    'list.all': '全部',
    'list.refs': '参考',
    'list.added': '新增',
    'list.empty': '（这一组还没有物体）',
    'list.progress': '参考 {done}/{total}',
    'list.progressAdded': ' · 新增 {n}',
    'io.export': '导出 JSON',
    'io.import': '载入',
    'io.reset': '清空',
    'io.autosave': '自动存在浏览器本地，刷新不丢。',
    'io.confirmReset': '清空本场景的全部标注和路径？',
    'io.badJson': '这不是有效的 JSON：{err}',
    'io.noCoords': '载入了 {total} 个物体，但没有一个带坐标 —— 这多半是一份还没标注过的导出。',
    'io.loaded': '已载入 {n} 个带坐标的标注。',
    'view.mode3d': '3D',
    'view.cut': '切顶',
    'view.frame': '回到目标 (F)',
    'view.loading': '载入网格中…',
    'view.topdown': '正在渲染俯视图…',
    'view.failed': '网格载入失败：{err}',
    'view.baseline': '基线 {baseline}',
    'view.noTargets': '无参考文件',
    'topdown.title': '俯视（可点、可拖）',
    'topdown.scale': '{mm} 毫米/像素',
    'topdown.stale': '俯视图对应切顶 {h} m —— 松开滑块后重渲染',
    'obj.classLabel': '类别（可改）',
    'obj.classChanged': '类别已改：{from} → {to}',
    'obj.original': '原为 {label}',
    'obj.declared': '参考半径 {r} m',
    'obj.w': '宽', 'obj.d': '深', 'obj.h': '高',
    'obj.yaw': '朝向',
    'obj.confirm': '参考位置正确',
    'obj.absent': '此处无物',
    'obj.clear': '清除',
    'obj.prev': '← 上一个',
    'obj.next': '下一个 (Enter) →',
    'obj.note': '备注（例如：这是蓝色垃圾袋车，不是垃圾桶）',
    'status.pending': '未处理',
    'status.confirmed': '参考正确',
    'status.corrected': '已修正',
    'status.absent': '此处无物',
    'status.added': '新增',
    'read.status': '状态',
    'read.reference': '参考',
    'read.annotated': '标注',
    'read.offset': '偏移',
    'read.floor': '地面',
    'help.title': '操作',
    'help.body':
      '<b>3D：</b>左键拖 = 旋转 · 右键拖 = 平移 · 滚轮 = 缩放<br>' +
      '在网格上<b>单击</b> = 把目标放到那里<br>' +
      '<b>俯视：</b>单击 = 设中心 · 框内拖 = 移动 · 角点拖 = 改尺寸<br>' +
      '<b>方向键</b> = 1 cm（Shift = 10 cm）· <b>Enter</b> = 下一个<br>' +
      '<b>Del</b> = 删除当前新增物体（参考目标删不掉，只能标「此处无物」）',
  },
};

export const LANGS = Object.keys(STRINGS);

/** Keys present in one language and missing from another. Empty means complete. */
export function missingKeys() {
  const all = new Set(LANGS.flatMap((l) => Object.keys(STRINGS[l])));
  const out = {};
  for (const l of LANGS) {
    const gaps = [...all].filter((k) => !(k in STRINGS[l]));
    if (gaps.length) out[l] = gaps.sort();
  }
  return out;
}

/** Look up `key` in `lang`, filling `{name}` placeholders from `vars`. */
export function translate(lang, key, vars) {
  const table = STRINGS[lang] || STRINGS.en;
  // A missing key returns the key itself. Silence would leave a blank button.
  const raw = key in table ? table[key] : `⟨${key}⟩`;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/** A translator bound to one language, plus the language it is bound to. */
export function translator(lang) {
  const t = (key, vars) => translate(lang, key, vars);
  t.lang = lang;
  return t;
}
