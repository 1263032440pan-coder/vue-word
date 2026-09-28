import type Editor from '../canvas-editor'
import type { IElement } from '../canvas-editor/interface/Element'
import type { IRange } from '../canvas-editor/interface/Range'

const LINE_BREAK = '\u200B'

export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

/** 一次选区快照。发给后端前先 capture，回来后用同一份快照 replace。 */
export interface SelectionSnapshot {
  /** 选中文字。跨段时换行保留为 \n */
  text: string
  /** 编辑器内部纯文本，用来确认回写时选区还在 */
  plainText: string
  range: IRange
  /**
   * 选区按行拆开的矩形。
   * x/y 相对编辑器书写区；跨页时 y 已加上前面各页的高度和页间距。
   */
  rects: SelectionRect[]
  startPageNo: number
  endPageNo: number
  startRowNo: number
  endRowNo: number
  startColNo: number
  endColNo: number
}

export type SelectionReplacement = string | IElement[]

function elementsToText(list: IElement[] | null | undefined): string {
  if (!list?.length) return ''
  return list
    .map(el => {
      if (el.value === LINE_BREAK) return '\n'
      return el.value || ''
    })
    .join('')
}

function selectIfMatch(editor: Editor, range: IRange, plainText: string): IRange | null {
  if (range.startIndex < 0 || range.endIndex < range.startIndex) return null
  editor.command.executeReplaceRange(range)
  if (editor.command.getRangeText() !== plainText) return null
  return editor.command.getRange()
}

function resolveRange(
  editor: Editor,
  snapshot: SelectionSnapshot
): IRange | null {
  const current = selectIfMatch(editor, snapshot.range, snapshot.plainText)
  if (current) return current

  const matches = editor.command.getKeywordRangeList(snapshot.plainText) || []
  if (!matches.length) return null

  const ranked = [...matches].sort(
    (a, b) =>
      Math.abs(a.endIndex - snapshot.range.endIndex) -
      Math.abs(b.endIndex - snapshot.range.endIndex)
  )

  for (const match of ranked) {
    // 搜索结果的 startIndex 落在首字上，编辑器选区起点是它的前一个位置
    const selected =
      selectIfMatch(
        editor,
        { ...match, startIndex: match.startIndex - 1 },
        snapshot.plainText
      ) || selectIfMatch(editor, match, snapshot.plainText)
    if (selected) return selected
  }
  return null
}

export function createSelectionBridge(getEditor: () => Editor | null) {
  /** 读取当前选中文字，以及这段文字在页面上的坐标。没有选区时返回 null。 */
  function capture(): SelectionSnapshot | null {
    const editor = getEditor()
    if (!editor) return null
    const { command } = editor
    const range = command.getRange()
    if (range.startIndex < 0 || range.startIndex === range.endIndex) return null

    const plainText = command.getRangeText()
    if (!plainText) return null

    let context: ReturnType<Editor['command']['getRangeContext']>
    try {
      context = command.getRangeContext()
    } catch (err) {
      console.error('读取选区坐标失败', err)
      return null
    }
    if (!context || context.isCollapsed) return null

    const text = elementsToText(context.selectionElementList) || plainText
    return {
      text,
      plainText,
      range,
      rects: (context.rangeRects || []).map(rect => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      })),
      startPageNo: context.startPageNo,
      endPageNo: context.endPageNo,
      startRowNo: context.startRowNo,
      endRowNo: context.endRowNo,
      startColNo: context.startColNo,
      endColNo: context.endColNo
    }
  }

  /**
   * 用处理后的内容替换 capture 时的那段文字。
   * content 可以是纯文本（换行用 \n），也可以是编辑器元素数组。
   * 回写前会先恢复当时的选区；这段时间里不要再改文档。
   */
  function replace(
    snapshot: SelectionSnapshot,
    content: SelectionReplacement
  ): boolean {
    const editor = getEditor()
    if (!editor || !snapshot?.plainText) return false
    const payload = typeof content === 'string' ? [{ value: content }] : content
    if (!payload?.length) return false

    const range = resolveRange(editor, snapshot)
    if (!range) return false

    editor.command.executeReplaceRange(range)
    editor.command.executeInsertElementList(payload, { isReplace: true })
    return true
  }

  /**
   * 选中后交给 handler（里面发后端），返回的内容会替换原文。
   * 没有选区、或原文已经对不上时返回 false。
   */
  async function process(
    handler: (snapshot: SelectionSnapshot) => Promise<SelectionReplacement>
  ): Promise<boolean> {
    const snapshot = capture()
    if (!snapshot) return false
    const content = await handler(snapshot)
    return replace(snapshot, content)
  }

  return { capture, replace, process }
}
