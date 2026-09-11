import { useEffect, useState, useCallback } from "react"
import {
  Layout, Menu, Button, Input, Table, Tag, Card, Modal, message, Space,
  Typography, Tabs, Popconfirm, Switch, Tooltip, Badge, Descriptions,
} from "antd"
import {
  ApiOutlined, ClusterOutlined, HistoryOutlined,
  UserOutlined, LogoutOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined,
} from "@ant-design/icons"
import { api, pageOrigin, type Workspace, type HelpRequest, type User } from "./api"

const { Header, Sider, Content } = Layout
const { Text, Title } = Typography

const statusTag = (s: Workspace["status"]) => {
  if (s === "online") return <Badge status="success" text={<Text>在线</Text>} />
  if (s === "disabled") return <Badge status="error" text={<Text type="danger">已禁用</Text>} />
  return <Badge status="default" text={<Text type="secondary">离线</Text>} />
}

const maskKey = (k: string) =>
  k.length > 12 ? `${k.slice(0, 6)}${"*".repeat(8)}${k.slice(-4)}` : "*".repeat(k.length)

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("swarm_token"))
  const [page, setPage] = useState("account")

  if (!token) return <LoginPage onLogin={(t) => { localStorage.setItem("swarm_token", t); setToken(t) }} />

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider width={180} style={{ background: "#fff", borderRight: "1px solid #f0f0f0" }}>
        <div style={{ padding: "16px 16px 8px", fontWeight: 700, fontSize: 16 }}>🐝 agent_swarm</div>
        <Menu
          mode="inline"
          style={{ borderInlineEnd: "none" }}
          selectedKeys={[page]} onClick={(e) => setPage(e.key)}
          items={[
            { key: "account", icon: <ApiOutlined />, label: "接入" },
            { key: "workspaces", icon: <ClusterOutlined />, label: "工作区" },
            { key: "help", icon: <HistoryOutlined />, label: "求助记录" },
          ]}
        />
      </Sider>
      <Layout>
        <Header style={{ background: "#fff", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #f0f0f0" }}>
          <Title level={4} style={{ margin: 0 }}>
            {{ account: "接入", workspaces: "工作区看板", help: "求助记录" }[page]}
          </Title>
          <Space>
            <span><UserOutlined /> {localStorage.getItem("swarm_user")}</span>
            <Button icon={<LogoutOutlined />} size="small" onClick={() => {
              localStorage.removeItem("swarm_token"); localStorage.removeItem("swarm_user"); setToken(null)
            }}>退出</Button>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>
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
        setApiKeyShow(r.api_key) // 不直接登录，先让用户保存 key
      }
    } catch (e: any) { message.error(e.message) }
    setLoading(false)
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "#f0f2f5" }}>
      <Card style={{ width: 400 }}>
        <Title level={3} style={{ textAlign: "center" }}>🐝 agent_swarm</Title>
        <Tabs
          centered
          items={[
            { key: "login", label: "登录", children: loginForm() },
            { key: "register", label: "注册", children: registerForm() },
          ]}
          activeKey={mode}
          onChange={(k) => setMode(k as any)}
        />
      </Card>
      <Modal
        open={!!apiKeyShow} title="注册成功！请保存你的 API Key" closable={false}
        footer={<Button type="primary" onClick={() => { setApiKeyShow(null); setMode("login") }}>我已保存</Button>}
      >
        <Text>API Key 仅此一次展示，丢失后只能重置：</Text>
        <Input.Search readOnly value={apiKeyShow ?? ""} enterButton={<><CopyOutlined /> 复制</>}
          onSearch={() => { navigator.clipboard.writeText(apiKeyShow ?? ""); message.success("已复制") }}
          style={{ marginTop: 8 }} />
      </Modal>
    </div>
  )

  function loginForm() {
    return <Space direction="vertical" style={{ width: "100%" }}>
      <Input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input.Password placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} onPressEnter={submit} />
      <Button type="primary" block loading={loading} onClick={submit}>登录</Button>
    </Space>
  }
  function registerForm() {
    return <Space direction="vertical" style={{ width: "100%" }}>
      <Input placeholder="用户名（2-32字符）" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input.Password placeholder="密码（至少6位）" value={password} onChange={(e) => setPassword(e.target.value)} onPressEnter={submit} />
      <Button type="primary" block loading={loading} onClick={submit}>注册并生成 API Key</Button>
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
            title: "状态", dataIndex: "status", width: 100,
            render: (_: string, w) => statusTag(w.status),
          },
          { title: "名称", dataIndex: "name", width: 160,
            render: (v: string, w) => <a onClick={() => setDetail(w)}>{v}</a> },
          { title: "路径", dataIndex: "path", ellipsis: true,
            render: (v: string) => <Tooltip title={v}><Text code style={{ fontSize: 12 }}>{v}</Text></Tooltip> },
          { title: "用途", dataIndex: "purpose", ellipsis: true },
          { title: "归属", width: 120,
            render: (_: any, w) => <Tag>{w.owner?.username}</Tag> },
          { title: "最后心跳", dataIndex: "last_heartbeat", width: 170,
            render: (v: string | null) => v ? new Date(v + "Z").toLocaleString() : "-" },
          {
            title: "操作", width: 170,
            render: (_: any, w) => (
              <Space size="small">
                <Switch
                  size="small"
                  checked={w.status !== "disabled"}
                  onChange={(v) => toggle(w, v)}
                />
                <Popconfirm
                  title="删除工作区？"
                  description={w.status === "online" ? "在线工作区不能删除" : "确认删除该工作区记录？"}
                  disabled={w.status === "online"}
                  onConfirm={async () => {
                    try { await api.deleteWorkspace(w.id); message.success("已删除"); refresh() }
                    catch (e: any) { message.error(e.message) }
                  }}
                >
                  <Tooltip title={w.status === "online" ? "在线工作区需先禁用或等其离线" : ""}>
                    <Button danger size="small" disabled={w.status === "online"}>删除</Button>
                  </Tooltip>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal open={!!detail} title={detail?.name} footer={null} onCancel={() => setDetail(null)}>
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="状态">{statusTag(detail.status)}</Descriptions.Item>
            <Descriptions.Item label="路径"><Text code>{detail.path}</Text></Descriptions.Item>
            <Descriptions.Item label="用途">{detail.purpose || "-"}</Descriptions.Item>
            <Descriptions.Item label="能力">{detail.capabilities || "-"}</Descriptions.Item>
            <Descriptions.Item label="备注">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.notes || "-"}</pre>
            </Descriptions.Item>
            <Descriptions.Item label="归属">{detail.owner?.username ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="最后心跳">
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
    pending: "orange", accepted: "blue", done: "green", failed: "red",
  }

  return (
    <>
      <Table
        rowKey="id" loading={loading} dataSource={list} size="middle" pagination={{ pageSize: 20 }}
        columns={[
          { title: "时间", dataIndex: "created_at", width: 170,
            render: (v: string) => new Date(v + "Z").toLocaleString() },
          { title: "求助方", width: 160, render: (_: any, r) => r.requester?.name ?? "-" },
          { title: "目标", width: 160, render: (_: any, r) => r.target?.name ?? "-" },
          { title: "模式", dataIndex: "mode", width: 100,
            render: (m: string) => <Tag>{m === "foreground" ? "前台" : "后台"}</Tag> },
          { title: "状态", dataIndex: "status", width: 100,
            render: (s: string) => <Tag color={statusColor[s]}>{s}</Tag> },
          { title: "问题", dataIndex: "question", ellipsis: true,
            render: (v: string, r) => <a onClick={() => setDetail(r)}>{v}</a> },
        ]}
      />
      <Modal open={!!detail} title="求助详情" footer={null} onCancel={() => setDetail(null)}>
      {detail && (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="求助方">{detail.requester?.name} ({detail.requester?.path})</Descriptions.Item>
          <Descriptions.Item label="目标">{detail.target?.name} ({detail.target?.path})</Descriptions.Item>
          <Descriptions.Item label="模式">{detail.mode === "foreground" ? "前台" : "后台"}</Descriptions.Item>
          <Descriptions.Item label="状态">{detail.status}</Descriptions.Item>
          <Descriptions.Item label="问题">
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.question}</pre>
          </Descriptions.Item>
          <Descriptions.Item label="结果">
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
    <div style={{ maxWidth: 860 }}>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Text strong style={{ flexShrink: 0 }}>API Key</Text>
          <Text code style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {me ? (showKey ? key : maskKey(key)) : "加载中..."}
          </Text>
          <Tooltip title={showKey ? "隐藏" : "显示"}>
            <Button type="text" size="small" icon={showKey ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={() => setShowKey(!showKey)} />
          </Tooltip>
          <Tooltip title="复制">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
              navigator.clipboard.writeText(key)
              message.success("已复制")
            }} />
          </Tooltip>
          <Popconfirm title="重置后旧 Key 立即失效，所有使用旧 Key 的 agent 将无法连接。确认重置？"
            onConfirm={reset}>
            <Button danger size="small">重置</Button>
          </Popconfirm>
        </div>
      </Card>
      <InstallPluginCard apiKey={key} />
    </div>
  )
}

function InstallPluginCard({ apiKey }: { apiKey: string }) {
  const installCmd = `curl -fsSL ${pageOrigin}/download/install.sh | bash -s -- --server ${pageOrigin} --api-key ${apiKey}`
  const hasKey = !!apiKey

  return (
    <Card title="接入 AI 编程工具">
      <Text type="secondary">
        在装有 AI 编程工具的机器上执行以下命令，即可接入 agent_swarm：
      </Text>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <Text code style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "8px 10px", background: "#f6f6f6", borderRadius: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {hasKey ? installCmd : "请先获取 API Key"}
        </Text>
        <Tooltip title="复制安装命令">
          <Button type="text" icon={<CopyOutlined />} disabled={!hasKey} onClick={() => {
            navigator.clipboard.writeText(installCmd)
            message.success("安装命令已复制，到目标机器执行即可")
          }} />
        </Tooltip>
      </div>
    </Card>
  )
}
