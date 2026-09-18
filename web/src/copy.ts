/** 复制文本到剪贴板。navigator.clipboard 仅在安全上下文（HTTPS/localhost）存在，
 *  自托管部署常用 http://IP:port 访问 → 回退 execCommand 方案。返回是否成功。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 落到 fallback */ }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
