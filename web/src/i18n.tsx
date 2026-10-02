/** 轻量 i18n：不引第三方库。
 *
 * 设计取舍：本站文案大量内联在 JSX 里、且和代码/命令混排，维护一张 key→文案的
 * 字典反而更难对齐。这里用 `useI18n().t(zh, en)` 就地双语（纯文本/属性），
 * 富文本（含 <b>/<code> 内联节点）用 `<L zh={...} en={...} />`。
 * 语言存 localStorage（`swarm_lang`），默认中文。 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

export type Lang = "zh" | "en"

const LS_KEY = "swarm_lang"

/** 读本地语言偏好；默认中文（含非 en 的脏值） */
function readLang(): Lang {
  try {
    return localStorage.getItem(LS_KEY) === "en" ? "en" : "zh"
  } catch {
    return "zh"
  }
}

type LangCtx = { lang: Lang; setLang: (l: Lang) => void }

const Ctx = createContext<LangCtx>({ lang: "zh", setLang: () => {} })

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang)
  const setLang = (l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(LS_KEY, l)
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  }
  useEffect(() => {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN"
  }, [lang])
  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>
}

/** 非组件环境（如 api.ts 的抛错文案）读取当前语言并翻译：读 localStorage，默认中文。 */
export function tGlobal(zh: string, en: string): string {
  return readLang() === "en" ? en : zh
}

/** 组件内取当前语言与翻译函数。t(中文, English) 返回当前语言文案。 */
export function useI18n() {
  const { lang, setLang } = useContext(Ctx)
  const t = (zh: string, en: string) => (lang === "en" ? en : zh)
  return { lang, setLang, t }
}

/** 富文本双语切换：正文里含 <b>/<code>/<a> 等内联节点时用它包一层。 */
export function L({ zh, en }: { zh: ReactNode; en: ReactNode }) {
  const { lang } = useContext(Ctx)
  return <>{lang === "en" ? en : zh}</>
}
