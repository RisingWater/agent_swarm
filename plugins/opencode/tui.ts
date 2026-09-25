/** V2 CLI（TUI）插件入口。
 *
 * opencode V2 的插件发现规则是「server 入口 index.ts 与 TUI 入口 tui.ts 放在一起」
 * （<dir>/index.ts + <dir>/tui.ts），不读 package.json exports。
 * 这里只做转发，实现放在 src/v2/tui.ts。
 */
export { default } from "./src/v2/tui"
