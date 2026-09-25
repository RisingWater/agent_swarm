/** V2 插件包入口。
 *
 * opencode V2 从「插件目录根的 index.ts」加载实现（不读 package.json exports），
 * 因此这里只做转发，真正的实现放在 src/v2/index.ts。
 */
export { default } from "./src/v2/index"
