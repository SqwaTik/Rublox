--[[
  Roblox AI Assistant — плагин Studio
  Связывает текущий place с веб-чатом через long-poll к локальному серверу.

  Установка для разработки:
    1. Скопируйте этот файл в папку плагинов Studio либо
       Plugins → Save as Local Plugin.
    2. В Game Settings → Security включите "Allow HTTP Requests".
    3. Откройте панель плагина, укажите URL сервера и токен, нажмите Connect.
]]

local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local LogService = game:GetService("LogService")
local ServerStorage = game:GetService("ServerStorage")

-- ── Конфигурация (можно поменять в полях UI) ──────────
local serverUrl = "http://localhost:8787"
local token = "change-me"
local connected = false

-- Буфер консоли: подписываемся на LogService.
local consoleBuffer = {}
LogService.MessageOut:Connect(function(message, msgType)
	table.insert(consoleBuffer, { text = message, type = tostring(msgType) })
	if #consoleBuffer > 300 then
		table.remove(consoleBuffer, 1)
	end
end)

-- ── UI: toolbar + dock widget ─────────────────────────
local toolbar = plugin:CreateToolbar("AI Assistant")
local button = toolbar:CreateButton("AI Chat", "Подключение к AI-чату", "rbxassetid://0")
button.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right, false, false, 320, 420, 280, 360
)
local widget = plugin:CreateDockWidgetPluginGui("AIAssistantWidget", widgetInfo)
widget.Title = "AI Assistant"

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(23, 27, 34)
root.BorderSizePixel = 0
root.Parent = widget

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = root

local pad = Instance.new("UIPadding")
pad.PaddingTop = UDim.new(0, 10)
pad.PaddingLeft = UDim.new(0, 10)
pad.PaddingRight = UDim.new(0, 10)
pad.Parent = root

local function makeLabel(text, order)
	local l = Instance.new("TextLabel")
	l.Size = UDim2.new(1, 0, 0, 16)
	l.BackgroundTransparency = 1
	l.TextColor3 = Color3.fromRGB(138, 147, 163)
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Font = Enum.Font.Gotham
	l.TextSize = 12
	l.Text = text
	l.LayoutOrder = order
	l.Parent = root
	return l
end

local function makeInput(default, order)
	local box = Instance.new("TextBox")
	box.Size = UDim2.new(1, 0, 0, 28)
	box.BackgroundColor3 = Color3.fromRGB(30, 36, 45)
	box.TextColor3 = Color3.fromRGB(230, 233, 239)
	box.BorderSizePixel = 0
	box.Font = Enum.Font.Code
	box.TextSize = 13
	box.ClearTextOnFocus = false
	box.Text = default
	box.LayoutOrder = order
	box.Parent = root
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, 6)
	c.Parent = box
	return box
end

makeLabel("URL сервера", 1)
local urlBox = makeInput(serverUrl, 2)
makeLabel("Токен", 3)
local tokenBox = makeInput(token, 4)

local connectBtn = Instance.new("TextButton")
connectBtn.Size = UDim2.new(1, 0, 0, 34)
connectBtn.BackgroundColor3 = Color3.fromRGB(79, 140, 255)
connectBtn.TextColor3 = Color3.fromRGB(255, 255, 255)
connectBtn.BorderSizePixel = 0
connectBtn.Font = Enum.Font.GothamBold
connectBtn.TextSize = 14
connectBtn.Text = "Connect"
connectBtn.LayoutOrder = 5
connectBtn.Parent = root
local cbc = Instance.new("UICorner")
cbc.CornerRadius = UDim.new(0, 6)
cbc.Parent = connectBtn

local statusLabel = makeLabel("Статус: отключён", 6)
statusLabel.TextColor3 = Color3.fromRGB(248, 81, 73)

local logBox = Instance.new("TextLabel")
logBox.Size = UDim2.new(1, 0, 0, 220)
logBox.BackgroundColor3 = Color3.fromRGB(14, 17, 22)
logBox.TextColor3 = Color3.fromRGB(138, 147, 163)
logBox.BorderSizePixel = 0
logBox.Font = Enum.Font.Code
logBox.TextSize = 11
logBox.TextXAlignment = Enum.TextXAlignment.Left
logBox.TextYAlignment = Enum.TextYAlignment.Top
logBox.TextWrapped = true
logBox.Text = ""
logBox.LayoutOrder = 7
logBox.Parent = root
local lbc = Instance.new("UICorner")
lbc.CornerRadius = UDim.new(0, 6)
lbc.Parent = logBox

local logLines = {}
local function log(msg)
	table.insert(logLines, os.date("%H:%M:%S ") .. msg)
	if #logLines > 14 then
		table.remove(logLines, 1)
	end
	logBox.Text = table.concat(logLines, "\n")
end

-- ── Исполнители инструментов ──────────────────────────

-- Выполнить Lua-код. loadstring в плагине отключён, поэтому используем
-- ModuleScript со вставкой исходника и require.
local function toolRunCode(args)
	local code = args.code or ""
	local mod = Instance.new("ModuleScript")
	mod.Name = "AI_RunCode_" .. tostring(math.random(1, 1e6))
	-- Оборачиваем код в функцию-модуль, возвращающую результат.
	mod.Source = "return function()\n" .. code .. "\nend"
	mod.Parent = ServerStorage
	local ok, fnOrErr = pcall(require, mod)
	local result
	if ok and typeof(fnOrErr) == "function" then
		local ran, ret = pcall(fnOrErr)
		result = ran and ("ok: " .. tostring(ret)) or ("runtime error: " .. tostring(ret))
	else
		result = "compile error: " .. tostring(fnOrErr)
	end
	mod:Destroy()
	return result
end

local function toolInsertModel(args)
	local assetId = tonumber(args.assetId)
	if not assetId then
		error("assetId не указан")
	end
	local objects = InsertService:LoadAsset(assetId)
	objects.Parent = workspace
	for _, child in ipairs(objects:GetChildren()) do
		child.Parent = workspace
	end
	objects:Destroy()
	return "Ассет " .. assetId .. " вставлен в Workspace"
end

local function toolGetConsole(args)
	local n = tonumber(args.lines) or 50
	local start = math.max(1, #consoleBuffer - n + 1)
	local out = {}
	for i = start, #consoleBuffer do
		table.insert(out, consoleBuffer[i].text)
	end
	return out
end

-- Краткое оглавление дерева place (экономит токены).
local function buildTree(inst, depth)
	local node = { name = inst.Name, className = inst.ClassName, children = {} }
	if depth > 0 then
		for _, child in ipairs(inst:GetChildren()) do
			table.insert(node.children, buildTree(child, depth - 1))
		end
	end
	return node
end

local function toolGetStudioContext(args)
	local depth = tonumber(args.depth) or 2
	local services = { workspace, game:GetService("ReplicatedStorage"), ServerStorage,
		game:GetService("ServerScriptService"), game:GetService("StarterGui"),
		game:GetService("StarterPlayer") }
	local tree = { name = "game", className = "DataModel", children = {} }
	for _, svc in ipairs(services) do
		table.insert(tree.children, buildTree(svc, depth))
	end
	return tree
end

-- Play-режим. У плагина нет публичного API для запуска/остановки плей-теста
-- (это ограничение песочницы Studio), поэтому сообщаем состояние и просим
-- пользователя нажать F5/Shift+F5, если требуется смена режима.
local RunService = game:GetService("RunService")

local function toolStartStopPlay(args)
	local action = tostring(args.action or "")
	local running = RunService:IsRunning()
	if action == "start" then
		if running then
			return "Play уже запущен."
		end
		return "Запуск Play недоступен из плагина. Нажмите F5 в Studio, затем повторите команду."
	elseif action == "stop" then
		if not running then
			return "Play не запущен."
		end
		return "Остановка Play недоступна из плагина. Нажмите Shift+F5 в Studio."
	end
	return "Неизвестное действие. Используйте start или stop. Текущий режим: "
		.. (running and "Play" or "Edit")
end

local function toolRunScriptInPlayMode(args)
	if not RunService:IsRunning() then
		error("Play-режим не запущен. Нажмите F5 в Studio и повторите.")
	end
	-- В Play-режиме выполняем код тем же способом, что и run_code.
	-- context (server/client) учитывается информативно: плагин исполняет
	-- в текущем датамодели Studio.
	local ctx = tostring(args.context or "server")
	local result = toolRunCode({ code = args.code })
	return "[play/" .. ctx .. "] " .. tostring(result)
end

local TOOLS = {
	run_code = toolRunCode,
	insert_model = toolInsertModel,
	get_console_output = toolGetConsole,
	get_studio_context = toolGetStudioContext,
	start_stop_play = toolStartStopPlay,
	run_script_in_play_mode = toolRunScriptInPlayMode,
}

local function executeCommand(cmd)
	local handler = TOOLS[cmd.tool]
	if not handler then
		return nil, "Неизвестный инструмент: " .. tostring(cmd.tool)
	end
	local ok, result = pcall(handler, cmd.args or {})
	if ok then
		return result, nil
	else
		return nil, tostring(result)
	end
end

-- ── Сеть: long-poll и отправка результатов ────────────
local function post(path, body)
	local url = urlBox.Text .. path
	return HttpService:RequestAsync({
		Url = url,
		Method = "POST",
		Headers = {
			["Content-Type"] = "application/json",
			["Authorization"] = "Bearer " .. tokenBox.Text,
		},
		Body = HttpService:JSONEncode(body),
	})
end

local function sendResult(id, result, err)
	pcall(post, "/api/roblox/result", { id = id, result = result, error = err })
end

local function pollOnce()
	local studioInfo = { placeName = game.Name, placeId = game.PlaceId }
	local res = post("/api/roblox/poll", { studioInfo = studioInfo })
	if not res.Success then
		error("HTTP " .. tostring(res.StatusCode))
	end
	local data = HttpService:JSONDecode(res.Body)
	for _, cmd in ipairs(data.commands or {}) do
		log("Команда: " .. cmd.tool)
		local result, err = executeCommand(cmd)
		sendResult(cmd.id, result, err)
		if err then
			log("Ошибка: " .. err)
		end
	end
end

local pollRunning = false
local function startPolling()
	if pollRunning then
		return
	end
	pollRunning = true
	task.spawn(function()
		while connected do
			local ok, err = pcall(pollOnce)
			if not ok then
				log("Сбой связи: " .. tostring(err))
				task.wait(3)
			else
				task.wait(0.2)
			end
		end
		pollRunning = false
	end)
end

local function setConnected(state)
	connected = state
	if state then
		statusLabel.Text = "Статус: подключён"
		statusLabel.TextColor3 = Color3.fromRGB(63, 185, 80)
		connectBtn.Text = "Disconnect"
		connectBtn.BackgroundColor3 = Color3.fromRGB(248, 81, 73)
		log("Подключение к " .. urlBox.Text)
		startPolling()
	else
		statusLabel.Text = "Статус: отключён"
		statusLabel.TextColor3 = Color3.fromRGB(248, 81, 73)
		connectBtn.Text = "Connect"
		connectBtn.BackgroundColor3 = Color3.fromRGB(79, 140, 255)
		pcall(post, "/api/roblox/disconnect", {})
		log("Отключено")
	end
end

connectBtn.MouseButton1Click:Connect(function()
	setConnected(not connected)
end)

button.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

log("Плагин загружен. Укажите URL/токен и нажмите Connect.")

