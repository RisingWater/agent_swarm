import { useEffect, useState, useCallback } from "react"
import {
  Layout, Menu, Button, Input, Table, Tag, Card, Modal, message, Space,
  Typography, Tabs, Popconfirm, Switch, Tooltip, Badge, Descriptions,
} from "antd"
import {
  ApiOutlined, ClusterOutlined, HistoryOutlined,
  LogoutOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined, UserOutlined,
} from "@ant-design/icons"
import { api, pageOrigin, type Workspace, type HelpRequest, type User } from "./api"

const { Header, Sider, Content } = Layout
const { Text, Title } = Typography

const statusTag = (s: Workspace["status"]) => {
  if (s === "online") return <Badge status="success" text={<Text style={{ color: "#c7c7cc" }}>online</Text>} />
  if (s === "disabled") return <Badge status="error" text={<Text type="danger" style={{ color: "#ff453a" }}>disabled</Text>} />
  return <Badge status="default" text={<Text type="secondary">offline</Text>} />
}

const maskKey = (k: string) => "*".repeat(k.length - 2) + k.slice(-2)

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 20px 14px" }}>
      <span
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 26, border: "1.5px solid #007aff", borderRadius: 5,
          color: "#007aff", fontWeight: 700, fontSize: 13,
        }}
      >
        &gt;_
      </span>
      <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "0.02em" }}>agent_swarm</span>
    </div>
  )
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("swarm_token"))
  const [page, setPage] = useState("account")

  if (!token)
    return <LoginPage onLogin={(t) => { localStorage.setItem("swarm_token", t); setToken(t) }} />

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider width={190} style={{ borderRight: "1px solid #2c2c2e" }}>
        <Logo />
        <Menu
          mode="inline"
          style={{ borderInlineEnd: "none", padding: "0 8px" }}
          selectedKeys={[page]}
          onClick={(e) => setPage(e.key)}
          items={[
            { key: "account", icon: <ApiOutlined />, label: "接入" },
            { key: "workspaces", icon: <ClusterOutlined />, label: "工作区" },
            { key: "help", icon: <HistoryOutlined />, label: "求助记录" },
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            padding: "0 28px", display: "flex", justifyContent: "space-between",
            alignItems: "center", borderBottom: "1px solid #2c2c2e", height: 56,
          }}
        >
          <Text type="secondary" style={{ fontSize: 13 }}>
            {{ account: "~/接入", workspaces: "~/工作区", help: "~/求助记录" }[page]}
          </Text>
          <Space size={12}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              <UserOutlined style={{ marginRight: 6 }} />
              {localStorage.getItem("swarm_user")}
            </Text>
            <Button
              type="text" size="small" icon={<LogoutOutlined />}
              onClick={() => {
                localStorage.removeItem("swarm_token")
                localStorage.removeItem("swarm_user")
                setToken(null)
              }}
            />
          </Space>
        </Header>
        <Content style={{ padding: 28, maxWidth: 1100 }}>
          {page === "account" && <AccountPage />}
          {page === "workspaces" && <WorkspacesPage />}
          {page === "help" && <HelpPage />}
        </Content>
      </Layout>
    </Layout>
  )
}

// ---------------- 登录/注册 ----------------

function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [apiKeyShow, setApiKeyShow] = useState<string | null>(null)

  const submit = async () => {
    setLoading(true)
    try {
      if (mode === "login") {
        const r = await api.login(username, password)
        localStorage.setItem("swarm_user", r.user.username)
        onLogin(r.token)
      } else {
        const r = await api.register(username, password)
        setApiKeyShow(r.api_key)
      }
    } catch (e: any) { message.error(e.message) }
    setLoading(false)
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
      <div style={{ width: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <span
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 52, height: 52, border: "2px solid #007aff", borderRadius: 8,
              color: "#007aff", fontWeight: 700, fontSize: 22,
            }}
          >
            &gt;_
          </span>
          <Title level={3} style={{ marginTop: 16, marginBottom: 4 }}>agent_swarm</Title>
          <Text type="secondary">multi-agent coordination hub</Text>
        </div>
        <Card>
          <Tabs
            centered
            items={[
              { key: "login", label: "login", children: loginForm() },
              { key: "register", label: "register", children: registerForm() },
            ]}
            activeKey={mode}
            onChange={(k) => setMode(k as any)}
          />
        </Card>
      </div>
      <Modal
        open={!!apiKeyShow} title="your api key" closable={false}
        footer={<Button type="primary" onClick={() => { setApiKeyShow(null); setMode("login") }}>ok, saved</Button>}
      >
        <Text type="secondary">key 可以随时在「接入」页查看，但请妥善保管：</Text>
        <Text code style={{ display: "block", marginTop: 8, padding: "8px 12px", fontSize: 13, wordBreak: "break-all" }}>
          {apiKeyShow}
        </Text>
      </Modal>
    </div>
  )

  function loginForm() {
    return <Space direction="vertical" style={{ width: "100%" }}>
      <Input prefix={<Text type="secondary">$</Text>} placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input.Password prefix={<Text type="secondary">$</Text>} placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} onPressEnter={submit} />
      <Button type="primary" block loading={loading} onClick={submit}>login</Button>
    </Space>
  }
  function registerForm() {
    return <Space direction="vertical" style={{ width: "100%" }}>
      <Input prefix={<Text type="secondary">$</Text>} placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input.Password prefix={<Text type="secondary">$</Text>} placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} onPressEnter={submit} />
      <Button type="primary" block loading={loading} onClick={submit}>register</Button>
    </Space>
  }
}

// ---------------- 工作区 ----------------

function WorkspacesPage() {
  const [list, setList] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<Workspace | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setList(await api.workspaces()) } catch (e: any) { message.error(e.message) }
    setLoading(false)
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const toggle = async (w: Workspace, enabled: boolean) => {
    try {
      if (enabled) await api.enableWorkspace(w.id)
      else await api.disableWorkspace(w.id)
      message.success(enabled ? "已启用" : "已禁用")
      refresh()
    } catch (e: any) { message.error(e.message) }
  }

  return (
    <>
      <Table
        rowKey="id" loading={loading} dataSource={list} size="middle"
        pagination={false}
        columns={[
          {
            title: "status", width: 110,
            render: (_: string, w) => statusTag(w.status),
          },
          { title: "name", dataIndex: "name", width: 170,
            render: (v: string, w) => <a onClick={() => setDetail(w)} style={{ color: "#007aff" }}>{v}</a> },
          { title: "path", dataIndex: "path", ellipsis: true,
            render: (v: string) => <Tooltip title={v}><Text type="secondary" style={{ fontSize: 12 }}>{v}</Text></Tooltip> },
          { title: "purpose", dataIndex: "purpose", ellipsis: true },
          { title: "owner", dataIndex: ["owner", "username"], width: 110,
            render: (v: string) => <Text type="secondary">{v}</Text> },
          { title: "heartbeat", dataIndex: "last_heartbeat", width: 120,
            render: (v: string | null) => v
              ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v + "Z").toLocaleTimeString()}</Text>
              : <Text type="secondary">-</Text> },
          {
            title: "", width: 120,
            render: (_: any, w) => (
              <Space size={4}>
                <Switch
                  size="small"
                  checked={w.status !== "disabled"}
                  onChange={(v) => toggle(w, v)}
                />
                <Popconfirm
                  title="delete this workspace?"
                  disabled={w.status === "online"}
                  onConfirm={async () => {
                    try { await api.deleteWorkspace(w.id); message.success("deleted"); refresh() }
                    catch (e: any) { message.error(e.message) }
                  }}
                >
                  <Button danger type="text" size="small" disabled={w.status === "online"}>rm</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal open={!!detail} title={detail?.name} footer={null} onCancel={() => setDetail(null)}>
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="status">{statusTag(detail.status)}</Descriptions.Item>
            <Descriptions.Item label="path"><Text code>{detail.path}</Text></Descriptions.Item>
            <Descriptions.Item label="purpose">{detail.purpose || "-"}</Descriptions.Item>
            <Descriptions.Item label="capabilities">{detail.capabilities || "-"}</Descriptions.Item>
            <Descriptions.Item label="notes">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.notes || "-"}</pre>
            </Descriptions.Item>
            <Descriptions.Item label="owner">{detail.owner?.username ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="heartbeat">
              {detail.last_heartbeat ? new Date(detail.last_heartbeat + "Z").toLocaleString() : "-"}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </>
  )
}

// ---------------- 求助记录 ----------------

function HelpPage() {
  const [list, setList] = useState<HelpRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<HelpRequest | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setList(await api.helpRequests()) } catch (e: any) { message.error(e.message) }
    setLoading(false)
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const statusColor: Record<string, string> = {
    pending: "warning", accepted: "processing", done: "success", failed: "error",
  }

  return (
    <>
      <Table
        rowKey="id" loading={loading} dataSource={list} size="middle" pagination={{ pageSize: 20 }}
        columns={[
          { title: "time", dataIndex: "created_at", width: 110,
            render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v + "Z").toLocaleTimeString()}</Text> },
          { title: "from", width: 150, render: (_: any, r) => r.requester?.name ?? "-" },
          { title: "to", width: 150, render: (_: any, r) => r.target?.name ?? "-" },
          { title: "mode", dataIndex: "mode", width: 110,
            render: (m: string) => <Tag style={{ fontSize: 11 }}>{m}</Tag> },
          { title: "status", dataIndex: "status", width: 110,
            render: (s: string) => <Badge status={statusColor[s] as any} text={<Text style={{ fontSize: 12 }}>{s}</Text>} /> },
          { title: "question", dataIndex: "question", ellipsis: true,
            render: (v: string, r) => <a onClick={() => setDetail(r)} style={{ color: "#007aff" }}>{v}</a> },
        ]}
      />
      <Modal open={!!detail} title="help request" footer={null} onCancel={() => setDetail(null)}>
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="from">{detail.requester?.name} ({detail.requester?.path})</Descriptions.Item>
            <Descriptions.Item label="to">{detail.target?.name} ({detail.target?.path})</Descriptions.Item>
            <Descriptions.Item label="mode">{detail.mode}</Descriptions.Item>
            <Descriptions.Item label="status">{detail.status}</Descriptions.Item>
            <Descriptions.Item label="question">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.question}</pre>
            </Descriptions.Item>
            <Descriptions.Item label="result">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>
                {detail.status === "failed" ? detail.error : (detail.result ?? "-")}
              </pre>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </>
  )
}

// ---------------- 接入（API Key + 安装） ----------------

function AccountPage() {
  const [me, setMe] = useState<(User & { api_key: string }) | null>(null)
  const [showKey, setShowKey] = useState(false)

  const refresh = useCallback(() => {
    api.me().then(setMe).catch((e) => message.error(e.message))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const reset = async () => {
    try {
      await api.resetApiKey()
      message.success("API Key 已重置")
      refresh()
    } catch (e: any) { message.error(e.message) }
  }

  const key = me?.api_key ?? ""

  return (
    <div style={{ maxWidth: 1080 }}>
      <Card style={{ marginBottom: 16 }}>
        <Text type="secondary">[ api key ]</Text>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
            <Text
              code
              copyable={false}
              style={{
                fontSize: 13,
                padding: "9px 14px",
                flex: 1,
                minWidth: 320,
                maxWidth: 560,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {me ? (showKey ? key : maskKey(key)) : "loading..."}
            </Text>
            <Tooltip title={showKey ? "hide" : "show"}>
              <Button type="text" size="small" icon={showKey ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                onClick={() => setShowKey(!showKey)} />
            </Tooltip>
            <Tooltip title="copy">
              <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                navigator.clipboard.writeText(key)
                message.success("已复制")
              }} />
            </Tooltip>
            <Popconfirm title="重置后旧 Key 立即失效，所有 agent 将断开连接。确认？"
              onConfirm={reset}>
              <Button danger size="small">reset</Button>
            </Popconfirm>
          </div>
        </div>
      </Card>
      <InstallPluginCard apiKey={key} />
    </div>
  )
}

function InstallPluginCard({ apiKey }: { apiKey: string }) {
  const installCmd = `curl -fsSL ${pageOrigin}/download/install.sh | bash -s -- --api-key ${apiKey}`
  const hasKey = !!apiKey

  return (
    <Card>
      <Text type="secondary">[ install ]</Text>
      <div style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          在装有 AI 编程工具的机器上执行：
        </Text>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 4, marginTop: 8,
            border: "1px solid #2c2c2e", borderRadius: 5, background: "#0c0c0e", padding: "4px 4px 4px 14px",
          }}
        >
          <Text
            style={{
              flex: 1, minWidth: 0, fontSize: 13,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            <Text type="secondary" style={{ fontSize: 13 }}>$ </Text>
            {hasKey ? installCmd : "# 请先获取 api key"}
          </Text>
          <Tooltip title="copy">
            <Button type="text" size="small" icon={<CopyOutlined />} disabled={!hasKey} onClick={() => {
              navigator.clipboard.writeText(installCmd)
              message.success("安装命令已复制")
            }} />
          </Tooltip>
        </div>
      </div>
    </Card>
  )
}
