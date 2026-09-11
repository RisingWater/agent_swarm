/** opencode.ai 风格的深色终端主题 */
import { theme } from "antd"

export const swarmTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#007aff",
    colorInfo: "#007aff",
    colorBgBase: "#0c0c0e",
    colorBgContainer: "#161618",
    colorBgElevated: "#1c1c1f",
    colorBgLayout: "#0c0c0e",
    colorText: "#ffffff",
    colorTextSecondary: "#c7c7cc",
    colorTextTertiary: "#a1a1a6",
    colorBorder: "#38383a",
    colorBorderSecondary: "#2c2c2e",
    colorSuccess: "#30d158",
    colorWarning: "#ff9f0a",
    colorError: "#ff453a",
    borderRadius: 5,
    fontFamily:
      '"IBM Plex Mono", "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    wireframe: false,
  },
  components: {
    Layout: {
      siderBg: "#0c0c0e",
      headerBg: "#0c0c0e",
      bodyBg: "#0c0c0e",
    },
    Menu: {
      itemBg: "transparent",
      itemColor: "#a1a1a6",
      itemHoverColor: "#ffffff",
      itemSelectedColor: "#007aff",
      itemSelectedBg: "rgba(0, 122, 255, 0.12)",
      activeBarBorderWidth: 0,
    },
    Card: {
      colorBgContainer: "#161618",
      colorBorderSecondary: "#2c2c2e",
    },
    Table: {
      colorBgContainer: "transparent",
      headerBg: "#161618",
      rowHoverBg: "#1c1c1f",
      borderColor: "#2c2c2e",
    },
    Button: {
      borderRadius: 5,
      controlHeight: 32,
    },
    Input: { borderRadius: 5 },
  },
}
