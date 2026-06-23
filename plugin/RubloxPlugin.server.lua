--[[
  Rublox — плагин Roblox Studio
  Связывает текущий place с приложением Rublox через long-poll к локальному серверу.

  Установка:
    1. Нажмите «Установить плагин» в Rublox (URL и токен встроятся автоматически),
       либо Plugins → Save as Local Plugin.
    2. В Game Settings → Security включите "Allow HTTP Requests".
    3. Откройте панель плагина Rublox и нажмите Connect.
]]

local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local LogService = game:GetService("LogService")
local ServerStorage = game:GetService("ServerStorage")
local CollectionService = game:GetService("CollectionService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

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
local toolbar = plugin:CreateToolbar("Rublox")
local button = toolbar:CreateButton("Rublox", "Подключение к Rublox", "rbxassetid://0")
button.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right, false, false, 320, 420, 280, 360
)
local widget = plugin:CreateDockWidgetPluginGui("RubloxWidget", widgetInfo)
widget.Title = "Rublox"

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
	mod.Name = "Rublox_RunCode_" .. tostring(math.random(1, 1e6))
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

-- Краткое оглавление дерева place (экономит токены). path — для адресации.
local function buildTree(inst, depth, parentPath)
	local path = parentPath and (parentPath .. "." .. inst.Name) or inst.Name
	local node = { name = inst.Name, className = inst.ClassName, path = path, children = {} }
	if depth > 0 then
		for _, child in ipairs(inst:GetChildren()) do
			table.insert(node.children, buildTree(child, depth - 1, path))
		end
	end
	return node
end

local function toolGetStudioContext(args)
	local depth = tonumber(args.depth) or 2
	local services = { workspace, game:GetService("ReplicatedStorage"), ServerStorage,
		game:GetService("ServerScriptService"), game:GetService("StarterGui"),
		game:GetService("StarterPlayer") }
	local tree = { name = "game", className = "DataModel", path = "game", children = {} }
	for _, svc in ipairs(services) do
		table.insert(tree.children, buildTree(svc, depth, "game"))
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

-- ── Работа с Explorer: пути, свойства, создание/удаление ──

-- Разрешить путь вида "game.Workspace.Part" / "Workspace.Model.Part" в Instance.
local function resolvePath(path)
	if type(path) ~= "string" or path == "" then
		error("path не указан")
	end
	local parts = {}
	for token in string.gmatch(path, "[^%.]+") do
		table.insert(parts, token)
	end
	local node = game
	local startI = 1
	if parts[1] == "game" then
		startI = 2
	end
	for i = startI, #parts do
		local name = parts[i]
		local nextNode
		-- сначала пробуем как сервис (для первого сегмента), затем как ребёнка
		if i == startI then
			local ok, svc = pcall(function() return game:GetService(name) end)
			if ok and svc then nextNode = svc end
		end
		if not nextNode then
			nextNode = node:FindFirstChild(name)
		end
		if not nextNode then
			error("Не найден объект по пути: " .. path .. " (нет \"" .. name .. "\")")
		end
		node = nextNode
	end
	return node
end

-- Прочитать значение свойства в читаемый вид.
local function readableValue(v)
	local t = typeof(v)
	if t == "Vector3" then
		return string.format("Vector3.new(%.3g, %.3g, %.3g)", v.X, v.Y, v.Z)
	elseif t == "Color3" then
		return string.format("Color3.fromRGB(%d, %d, %d)",
			math.floor(v.R * 255 + 0.5), math.floor(v.G * 255 + 0.5), math.floor(v.B * 255 + 0.5))
	elseif t == "UDim2" then
		return string.format("UDim2.new(%.3g, %d, %.3g, %d)",
			v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset)
	elseif t == "CFrame" then
		local p = v.Position
		return string.format("CFrame.new(%.3g, %.3g, %.3g)", p.X, p.Y, p.Z)
	elseif t == "EnumItem" then
		return tostring(v)
	elseif t == "Instance" then
		return v:GetFullName()
	elseif t == "number" or t == "boolean" or t == "string" then
		return v
	end
	return tostring(v)
end

-- Распарсить значение из строки-конструктора (Vector3.new(...), Color3.fromRGB(...),
-- UDim2.new(...), CFrame.new(...), Enum.X.Y) либо вернуть как есть для примитивов.
local function parseValue(raw)
	if type(raw) ~= "string" then
		return raw
	end
	local s = raw
	-- Enum.Material.Neon и т.п.
	local category, item = string.match(s, "^Enum%.([%w_]+)%.([%w_]+)$")
	if category and item then
		return Enum[category][item]
	end
	local function nums(str)
		local out = {}
		for n in string.gmatch(str, "-?%d+%.?%d*") do
			table.insert(out, tonumber(n))
		end
		return out
	end
	if string.match(s, "^Vector3%.new") then
		local n = nums(s); return Vector3.new(n[1] or 0, n[2] or 0, n[3] or 0)
	elseif string.match(s, "^Color3%.fromRGB") then
		local n = nums(s); return Color3.fromRGB(n[1] or 0, n[2] or 0, n[3] or 0)
	elseif string.match(s, "^Color3%.new") then
		local n = nums(s); return Color3.new(n[1] or 0, n[2] or 0, n[3] or 0)
	elseif string.match(s, "^UDim2%.new") then
		local n = nums(s); return UDim2.new(n[1] or 0, n[2] or 0, n[3] or 0, n[4] or 0)
	elseif string.match(s, "^UDim%.new") then
		local n = nums(s); return UDim.new(n[1] or 0, n[2] or 0)
	elseif string.match(s, "^CFrame%.new") then
		local n = nums(s); return CFrame.new(n[1] or 0, n[2] or 0, n[3] or 0)
	elseif string.match(s, "^Vector2%.new") then
		local n = nums(s); return Vector2.new(n[1] or 0, n[2] or 0)
	end
	-- булевы/числа в виде строки
	if s == "true" then return true end
	if s == "false" then return false end
	local asNum = tonumber(s)
	if asNum ~= nil then return asNum end
	return s
end

local function applyProps(inst, props)
	local applied, errors = {}, {}
	for key, val in pairs(props or {}) do
		local ok, err = pcall(function()
			inst[key] = parseValue(val)
		end)
		if ok then
			table.insert(applied, key)
		else
			table.insert(errors, key .. ": " .. tostring(err))
		end
	end
	return applied, errors
end

local function toolGetInstanceProperties(args)
	local inst = resolvePath(args.path)
	local out = {
		Name = inst.Name,
		ClassName = inst.ClassName,
		Path = inst:GetFullName(),
		Properties = {},
	}
	-- Набор часто нужных свойств; читаем те, что есть у объекта.
	local candidates = {
		"Anchored", "CanCollide", "Transparency", "Reflectance", "Size", "Position",
		"CFrame", "Color", "Material", "Shape", "BrickColor", "Orientation",
		"Value", "Text", "Visible", "Enabled", "Health", "MaxHealth", "WalkSpeed",
		"JumpPower", "Brightness", "Range", "CastShadow", "Massless",
	}
	for _, prop in ipairs(candidates) do
		local ok, v = pcall(function() return inst[prop] end)
		if ok and v ~= nil then
			out.Properties[prop] = readableValue(v)
		end
	end
	return out
end

local function toolSetProperties(args)
	local inst = resolvePath(args.path)
	local applied, errors = applyProps(inst, args.properties)
	local msg = "Изменено: " .. table.concat(applied, ", ")
	if #errors > 0 then
		msg = msg .. " | Ошибки: " .. table.concat(errors, "; ")
	end
	return msg
end

local function toolCreateInstance(args)
	local className = tostring(args.className or "")
	if className == "" then error("className не указан") end
	local parent
	if args.parent and args.parent ~= "" then
		parent = resolvePath(args.parent)
	else
		parent = workspace
	end
	local inst
	local ok, err = pcall(function() inst = Instance.new(className) end)
	if not ok then error("Не удалось создать " .. className .. ": " .. tostring(err)) end
	if args.properties then applyProps(inst, args.properties) end
	inst.Parent = parent
	return "Создан " .. inst:GetFullName()
end

local function toolDeleteInstance(args)
	local inst = resolvePath(args.path)
	local full = inst:GetFullName()
	if inst == workspace or inst == game then
		error("Нельзя удалять корневые сервисы.")
	end
	inst:Destroy()
	return "Удалён " .. full
end

local function toolRenameInstance(args)
	local inst = resolvePath(args.path)
	local old = inst:GetFullName()
	inst.Name = tostring(args.newName or "")
	return "Переименован " .. old .. " → " .. inst.Name
end

-- Прочитать исходник скрипта (Script/LocalScript/ModuleScript) по пути.
local function toolGetScriptSource(args)
	local inst = resolvePath(args.path)
	if not inst:IsA("LuaSourceContainer") then
		error("Объект не является скриптом: " .. inst.ClassName)
	end
	return inst.Source
end

-- Заменить исходник скрипта по пути. Использует ScriptEditorService, чтобы
-- правка проходила корректно даже для открытых в редакторе скриптов.
local ScriptEditorService = game:GetService("ScriptEditorService")
local function toolSetScriptSource(args)
	local inst = resolvePath(args.path)
	if not inst:IsA("LuaSourceContainer") then
		error("Объект не является скриптом: " .. inst.ClassName)
	end
	local source = tostring(args.source or "")
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return source
		end)
	end)
	if not ok then
		-- Запасной путь: прямое присваивание Source.
		inst.Source = source
	end
	return "Исходник обновлён: " .. inst:GetFullName() .. " (" .. #source .. " символов)"
end

-- Точечная правка скрипта: заменить oldText → newText (одно или все вхождения).
local function toolEditScript(args)
	local inst = resolvePath(args.path)
	if not inst:IsA("LuaSourceContainer") then
		error("Объект не является скриптом: " .. inst.ClassName)
	end
	local oldText = tostring(args.oldText or "")
	local newText = tostring(args.newText or "")
	if oldText == "" then error("oldText пустой") end
	local source = inst.Source
	-- Поиск по простому совпадению (без паттернов): найдём подстроку plain.
	local idx = string.find(source, oldText, 1, true)
	if not idx then
		error("Фрагмент не найден в скрипте — проверь точное совпадение (get_script_source).")
	end
	local replaced
	if args.replaceAll then
		-- Заменяем все вхождения через ручной проход (plain, без magic-символов).
		local out, pos = {}, 1
		while true do
			local s, e = string.find(source, oldText, pos, true)
			if not s then table.insert(out, string.sub(source, pos)); break end
			table.insert(out, string.sub(source, pos, s - 1))
			table.insert(out, newText)
			pos = e + 1
		end
		replaced = table.concat(out)
	else
		-- Одно вхождение: проверим уникальность.
		local second = string.find(source, oldText, idx + #oldText, true)
		if second then
			error("Фрагмент встречается несколько раз — уточни oldText или replaceAll=true.")
		end
		replaced = string.sub(source, 1, idx - 1) .. newText .. string.sub(source, idx + #oldText)
	end
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function() return replaced end)
	end)
	if not ok then inst.Source = replaced end
	return "Скрипт изменён: " .. inst:GetFullName()
end

-- Найти объекты по имени и/или классу во всём дереве. Возвращает пути.
local function toolFindInstances(args)
	local nameQuery = args.name and tostring(args.name):lower() or nil
	local classQuery = args.className and tostring(args.className) or nil
	local limit = tonumber(args.limit) or 50
	local results = {}
	local roots = { workspace, game:GetService("ReplicatedStorage"), ServerStorage,
		game:GetService("ServerScriptService"), game:GetService("StarterGui"),
		game:GetService("StarterPlayer"), game:GetService("ReplicatedFirst"),
		game:GetService("Lighting") }
	for _, root in ipairs(roots) do
		for _, d in ipairs(root:GetDescendants()) do
			if #results >= limit then break end
			local okName = (not nameQuery) or string.find(d.Name:lower(), nameQuery, 1, true)
			local okClass = (not classQuery) or d.ClassName == classQuery or d:IsA(classQuery)
			if okName and okClass then
				table.insert(results, { name = d.Name, className = d.ClassName, path = d:GetFullName() })
			end
		end
	end
	return results
end

-- Выделить объект в Explorer (Selection), удобно для визуального контроля.
local Selection = game:GetService("Selection")
local function toolSelectInstance(args)
	local inst = resolvePath(args.path)
	Selection:Set({ inst })
	return "Выделен " .. inst:GetFullName()
end

-- Получить объекты, выделенные пользователем в Explorer прямо сейчас.
local function toolGetSelection()
	local sel = Selection:Get()
	if #sel == 0 then
		return "Ничего не выделено в Studio."
	end
	local out = {}
	for _, inst in ipairs(sel) do
		local props = {}
		local okv, v = pcall(function() return inst.Size end)
		if okv and v then props.Size = readableValue(v) end
		local okp, p = pcall(function() return inst.Position end)
		if okp and p then props.Position = readableValue(p) end
		table.insert(out, {
			name = inst.Name,
			className = inst.ClassName,
			path = inst:GetFullName(),
			properties = props,
		})
	end
	return out
end

-- Клонировать объект (со всеми детьми) count раз в указанного родителя.
local function toolDuplicateInstance(args)
	local inst = resolvePath(args.path)
	local parent = inst.Parent
	if args.parent and args.parent ~= "" then
		parent = resolvePath(args.parent)
	end
	local count = tonumber(args.count) or 1
	local made = {}
	for _ = 1, math.max(1, math.floor(count)) do
		local copy = inst:Clone()
		copy.Parent = parent
		table.insert(made, copy:GetFullName())
	end
	return "Создано копий: " .. #made .. " → " .. table.concat(made, ", ")
end

local CollectionService = game:GetService("CollectionService")

-- Переместить объект к другому родителю (reparent).
local function toolMoveInstance(args)
	local inst = resolvePath(args.path)
	inst.Parent = resolvePath(args.parent)
	return "Перемещено: " .. inst:GetFullName()
end

-- Список прямых детей узла (имя, класс, число детей) — дешевле всего дерева.
local function toolGetChildren(args)
	local inst = resolvePath(args.path)
	local out = {}
	for _, child in ipairs(inst:GetChildren()) do
		table.insert(out, {
			name = child.Name,
			className = child.ClassName,
			path = child:GetFullName(),
			children = #child:GetChildren(),
		})
	end
	if #out == 0 then
		return "У " .. inst:GetFullName() .. " нет детей."
	end
	return out
end

-- Прочитать атрибуты объекта (Instance:GetAttributes()).
local function toolGetAttributes(args)
	local inst = resolvePath(args.path)
	local out = {}
	for k, v in pairs(inst:GetAttributes()) do
		out[k] = readableValue(v)
	end
	if next(out) == nil then
		return "У " .. inst:GetFullName() .. " нет атрибутов."
	end
	return out
end

-- Установить атрибуты (Instance:SetAttribute). Значения парсятся как свойства.
local function toolSetAttributes(args)
	local inst = resolvePath(args.path)
	local applied = {}
	for k, v in pairs(args.attributes or {}) do
		inst:SetAttribute(k, parseValue(v))
		table.insert(applied, k)
	end
	return "Атрибуты установлены: " .. table.concat(applied, ", ")
end

-- CollectionService: добавить тег объекту.
local function toolAddTag(args)
	local inst = resolvePath(args.path)
	CollectionService:AddTag(inst, args.tag)
	return 'Тег "' .. tostring(args.tag) .. '" добавлен к ' .. inst:GetFullName()
end

-- CollectionService: снять тег.
local function toolRemoveTag(args)
	local inst = resolvePath(args.path)
	CollectionService:RemoveTag(inst, args.tag)
	return 'Тег "' .. tostring(args.tag) .. '" снят с ' .. inst:GetFullName()
end

-- CollectionService: получить теги объекта.
local function toolGetTags(args)
	local inst = resolvePath(args.path)
	local tags = CollectionService:GetTags(inst)
	if #tags == 0 then
		return "У " .. inst:GetFullName() .. " нет тегов."
	end
	return tags
end

-- Создать скрипт (Script/LocalScript/ModuleScript) с исходником сразу.
local function toolCreateScript(args)
	local class = args.scriptType or "Script"
	if class ~= "Script" and class ~= "LocalScript" and class ~= "ModuleScript" then
		error("scriptType должен быть Script | LocalScript | ModuleScript")
	end
	local parent = resolvePath(args.parent)
	local scr = Instance.new(class)
	scr.Name = args.name or class
	scr.Source = args.source or ""
	scr.Parent = parent
	return "Создан " .. class .. ": " .. scr:GetFullName()
end

-- Вызвать метод объекта (напр. :PivotTo, :MakeJoints, :BreakJoints).
local function toolCallMethod(args)
	local inst = resolvePath(args.path)
	local method = args.method
	if type(method) ~= "string" or inst[method] == nil then
		error("Метод не найден: " .. tostring(method))
	end
	local callArgs = {}
	for _, a in ipairs(args.args or {}) do
		table.insert(callArgs, parseValue(a))
	end
	local result = inst[method](inst, table.unpack(callArgs))
	if result == nil then
		return "Метод " .. method .. " вызван на " .. inst:GetFullName()
	end
	return readableValue(result)
end

-- Удалить всех детей узла (очистка контейнера).
local function toolClearChildren(args)
	local inst = resolvePath(args.path)
	local n = #inst:GetChildren()
	inst:ClearAllChildren()
	return "Удалено детей: " .. n .. " из " .. inst:GetFullName()
end

-- Посчитать объекты по классу во всём дереве (или в поддереве по path).
local function toolCountInstances(args)
	local root = game
	if args.path and args.path ~= "" then
		root = resolvePath(args.path)
	end
	local count = 0
	for _, d in ipairs(root:GetDescendants()) do
		if not args.className or d.ClassName == args.className then
			count = count + 1
		end
	end
	return "Найдено объектов" .. (args.className and (" класса " .. args.className) or "") .. ": " .. count
end

-- Сгруппировать объекты в новый Model или Folder.
local function toolGroupInstances(args)
	local container = Instance.new(args.container == "Folder" and "Folder" or "Model")
	container.Name = args.name or "Group"
	local grouped = {}
	local firstParent = nil
	for _, p in ipairs(args.paths or {}) do
		local inst = resolvePath(p)
		firstParent = firstParent or inst.Parent
		inst.Parent = container
		table.insert(grouped, inst.Name)
	end
	container.Parent = (args.parent and args.parent ~= "") and resolvePath(args.parent) or (firstParent or workspace)
	return "Сгруппировано (" .. #grouped .. ") в " .. container:GetFullName()
end

-- Цвет из hex "#RRGGBB" или имени; иначе серый.
local function colorFromHex(hex)
	if typeof(hex) == "Color3" then return hex end
	if type(hex) ~= "string" then return Color3.fromRGB(163, 162, 165) end
	local h = hex:gsub("#", "")
	if #h == 6 then
		local r = tonumber(h:sub(1, 2), 16) or 163
		local g = tonumber(h:sub(3, 4), 16) or 162
		local b = tonumber(h:sub(5, 6), 16) or 165
		return Color3.fromRGB(r, g, b)
	end
	return Color3.fromRGB(163, 162, 165)
end

-- Батч-постройка: создаёт Model с множеством Part по списку. Основа быстрых
-- построек по генплану. Каждая часть: { name, shape, position{x,y,z},
-- size{x,y,z}, color "#hex", material, orientation{x,y,z}, anchored }.
local function toolBuildParts(args)
	local parent = (args.parent and args.parent ~= "") and resolvePath(args.parent) or workspace
	local model = Instance.new("Model")
	model.Name = args.name or "Build"
	local parts = args.parts or {}
	local made = 0
	for _, spec in ipairs(parts) do
		local part
		local shape = spec.shape or "Block"
		if shape == "Ball" or shape == "Cylinder" or shape == "Wedge" or shape == "CornerWedge" then
			part = Instance.new("Part")
			part.Shape = (shape == "Ball" and Enum.PartType.Ball)
				or (shape == "Cylinder" and Enum.PartType.Cylinder)
				or Enum.PartType.Block
			if shape == "Wedge" then part = Instance.new("WedgePart") end
		else
			part = Instance.new("Part")
		end
		part.Name = spec.name or "Part"
		local sz = spec.size or {}
		part.Size = Vector3.new(tonumber(sz.x) or 4, tonumber(sz.y) or 4, tonumber(sz.z) or 4)
		local p = spec.position or {}
		local px, py, pz = tonumber(p.x) or 0, tonumber(p.y) or 0, tonumber(p.z) or 0
		local o = spec.orientation or {}
		part.CFrame = CFrame.new(px, py, pz)
			* CFrame.Angles(math.rad(tonumber(o.x) or 0), math.rad(tonumber(o.y) or 0), math.rad(tonumber(o.z) or 0))
		part.Color = colorFromHex(spec.color)
		if spec.material then
			pcall(function() part.Material = Enum.Material[spec.material] end)
		end
		part.Anchored = spec.anchored ~= false
		part.Parent = model
		made = made + 1
	end
	model.Parent = parent
	-- Центрируем pivot модели для удобства дальнейших трансформаций.
	pcall(function() model:SetAttribute("RubloxBuild", true) end)
	return "Построено частей: " .. made .. " в модели " .. model:GetFullName()
end

-- ── Интерактивность и UI ─────────────────────────────────────────────

-- Создать ProximityPrompt на объекте (кнопка-подсказка «нажмите E»).
local function toolAddProximityPrompt(args)
	local inst = resolvePath(args.path)
	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = args.actionText or "Использовать"
	prompt.ObjectText = args.objectText or inst.Name
	if args.keyCode then
		pcall(function() prompt.KeyboardKeyCode = Enum.KeyCode[args.keyCode] end)
	end
	if tonumber(args.holdDuration) then prompt.HoldDuration = tonumber(args.holdDuration) end
	if tonumber(args.maxDistance) then prompt.MaxActivationDistance = tonumber(args.maxDistance) end
	prompt.Parent = inst
	return "ProximityPrompt добавлен на " .. inst:GetFullName()
end

-- Создать ClickDetector на объекте (реакция на клик).
local function toolAddClickDetector(args)
	local inst = resolvePath(args.path)
	local cd = Instance.new("ClickDetector")
	if tonumber(args.maxDistance) then cd.MaxActivationDistance = tonumber(args.maxDistance) end
	cd.Parent = inst
	return "ClickDetector добавлен на " .. inst:GetFullName()
end

-- Создать ScreenGui с опциональным Frame внутри (основа интерфейса).
local function toolCreateScreenGui(args)
	local players = game:GetService("Players")
	local starterGui = game:GetService("StarterGui")
	local parent = starterGui
	if args.parent and args.parent ~= "" then parent = resolvePath(args.parent) end
	local gui = Instance.new("ScreenGui")
	gui.Name = args.name or "ScreenGui"
	gui.ResetOnSpawn = args.resetOnSpawn ~= false
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	gui.Parent = parent
	return "ScreenGui создан: " .. gui:GetFullName()
end

-- Создать UI-элемент (Frame/TextLabel/TextButton/ImageLabel/...) внутри родителя.
local function toolCreateUiElement(args)
	local parent = resolvePath(args.parent)
	local class = args.className or "Frame"
	local el = Instance.new(class)
	el.Name = args.name or class
	if el:IsA("GuiObject") then
		local sz = args.size or {}
		el.Size = UDim2.new(
			tonumber(sz.xScale) or 0, tonumber(sz.xOffset) or 100,
			tonumber(sz.yScale) or 0, tonumber(sz.yOffset) or 40)
		local pos = args.position or {}
		el.Position = UDim2.new(
			tonumber(pos.xScale) or 0, tonumber(pos.xOffset) or 0,
			tonumber(pos.yScale) or 0, tonumber(pos.yOffset) or 0)
		if args.bgColor then el.BackgroundColor3 = colorFromHex(args.bgColor) end
		if args.bgTransparency ~= nil then el.BackgroundTransparency = tonumber(args.bgTransparency) or 0 end
	end
	if args.text ~= nil and (el:IsA("TextLabel") or el:IsA("TextButton") or el:IsA("TextBox")) then
		el.Text = tostring(args.text)
		if args.textColor then el.TextColor3 = colorFromHex(args.textColor) end
		if tonumber(args.textSize) then el.TextSize = tonumber(args.textSize) end
	end
	el.Parent = parent
	return "UI-элемент " .. class .. " создан: " .. el:GetFullName()
end

-- ── Физика и соединения ──────────────────────────────────────────────

-- Сварить два объекта WeldConstraint (жёсткое соединение).
local function toolWeld(args)
	local a = resolvePath(args.part0)
	local b = resolvePath(args.part1)
	local weld = Instance.new("WeldConstraint")
	weld.Part0 = a
	weld.Part1 = b
	weld.Parent = a
	return "Сварено: " .. a.Name .. " ↔ " .. b.Name
end

-- Добавить Attachment к объекту (точка крепления для констрейнтов/эффектов).
local function toolAddAttachment(args)
	local inst = resolvePath(args.path)
	local att = Instance.new("Attachment")
	att.Name = args.name or "Attachment"
	local p = args.position or {}
	att.Position = Vector3.new(tonumber(p.x) or 0, tonumber(p.y) or 0, tonumber(p.z) or 0)
	att.Parent = inst
	return "Attachment добавлен на " .. inst:GetFullName()
end

-- Создать констрейнт между двумя Attachment (Hinge/Spring/Rope/Rod/Ball/Prismatic).
local function toolCreateConstraint(args)
	local class = (args.constraintType or "HingeConstraint")
	local att0 = resolvePath(args.attachment0)
	local att1 = resolvePath(args.attachment1)
	local c = Instance.new(class)
	c.Attachment0 = att0
	c.Attachment1 = att1
	c.Parent = att0.Parent
	if args.properties then applyProps(c, args.properties) end
	return class .. " создан между " .. att0.Name .. " и " .. att1.Name
end

-- ── Внешний вид: меш, декали, текстуры, свет ─────────────────────────

-- Добавить SpecialMesh/декаль/текстуру на объект.
local function toolAddDecal(args)
	local inst = resolvePath(args.path)
	local class = args.kind == "Texture" and "Texture" or "Decal"
	local d = Instance.new(class)
	d.Texture = args.texture or ""
	if args.face then pcall(function() d.Face = Enum.NormalId[args.face] end) end
	d.Parent = inst
	return class .. " добавлен на " .. inst:GetFullName()
end

-- Добавить источник света (PointLight/SpotLight/SurfaceLight) на объект.
local function toolAddLight(args)
	local inst = resolvePath(args.path)
	local class = args.lightType or "PointLight"
	local light = Instance.new(class)
	if args.color then light.Color = colorFromHex(args.color) end
	if tonumber(args.brightness) then light.Brightness = tonumber(args.brightness) end
	if tonumber(args.range) and light:IsA("PointLight") then light.Range = tonumber(args.range) end
	if tonumber(args.range) and light:IsA("SpotLight") then light.Range = tonumber(args.range) end
	light.Parent = inst
	return class .. " добавлен на " .. inst:GetFullName()
end

-- Добавить ParticleEmitter (частицы) на объект/Attachment.
local function toolAddParticle(args)
	local inst = resolvePath(args.path)
	local pe = Instance.new("ParticleEmitter")
	if args.texture then pe.Texture = args.texture end
	if tonumber(args.rate) then pe.Rate = tonumber(args.rate) end
	if args.color then
		local c = colorFromHex(args.color)
		pe.Color = ColorSequence.new(c)
	end
	if tonumber(args.lifetime) then pe.Lifetime = NumberRange.new(tonumber(args.lifetime)) end
	pe.Parent = inst
	return "ParticleEmitter добавлен на " .. inst:GetFullName()
end

-- ── Звук ─────────────────────────────────────────────────────────────

-- Добавить Sound (на объект или в SoundService), опц. автозапуск.
local function toolAddSound(args)
	local parent = (args.parent and args.parent ~= "") and resolvePath(args.parent)
		or game:GetService("SoundService")
	local sound = Instance.new("Sound")
	sound.Name = args.name or "Sound"
	sound.SoundId = args.soundId or ""
	if tonumber(args.volume) then sound.Volume = tonumber(args.volume) end
	sound.Looped = args.looped == true
	if args.playOnCreate then pcall(function() sound:Play() end) end
	sound.Parent = parent
	return "Sound создан: " .. sound:GetFullName()
end

-- ── Освещение сцены и атмосфера ──────────────────────────────────────

-- Настроить глобальное освещение (Lighting): время суток, тени, туман.
local function toolSetLighting(args)
	local Lighting = game:GetService("Lighting")
	local applied = {}
	if args.clockTime ~= nil then Lighting.ClockTime = tonumber(args.clockTime) or 14; table.insert(applied, "ClockTime") end
	if args.brightness ~= nil then Lighting.Brightness = tonumber(args.brightness) or 2; table.insert(applied, "Brightness") end
	if args.ambient then Lighting.Ambient = colorFromHex(args.ambient); table.insert(applied, "Ambient") end
	if args.outdoorAmbient then Lighting.OutdoorAmbient = colorFromHex(args.outdoorAmbient); table.insert(applied, "OutdoorAmbient") end
	if args.fogEnd ~= nil then Lighting.FogEnd = tonumber(args.fogEnd) or 100000; table.insert(applied, "FogEnd") end
	if args.fogColor then Lighting.FogColor = colorFromHex(args.fogColor); table.insert(applied, "FogColor") end
	return "Lighting настроен: " .. (#applied > 0 and table.concat(applied, ", ") or "без изменений")
end

local TOOLS = {
	build_parts = toolBuildParts,
	add_proximity_prompt = toolAddProximityPrompt,
	add_click_detector = toolAddClickDetector,
	create_screen_gui = toolCreateScreenGui,
	create_ui_element = toolCreateUiElement,
	weld = toolWeld,
	add_attachment = toolAddAttachment,
	create_constraint = toolCreateConstraint,
	add_decal = toolAddDecal,
	add_light = toolAddLight,
	add_particle = toolAddParticle,
	add_sound = toolAddSound,
	set_lighting = toolSetLighting,
	run_code = toolRunCode,
	insert_model = toolInsertModel,
	get_console_output = toolGetConsole,
	get_studio_context = toolGetStudioContext,
	get_instance_properties = toolGetInstanceProperties,
	set_properties = toolSetProperties,
	create_instance = toolCreateInstance,
	delete_instance = toolDeleteInstance,
	rename_instance = toolRenameInstance,
	get_script_source = toolGetScriptSource,
	set_script_source = toolSetScriptSource,
	edit_script = toolEditScript,
	find_instances = toolFindInstances,
	select_instance = toolSelectInstance,
	get_selection = toolGetSelection,
	duplicate_instance = toolDuplicateInstance,
	move_instance = toolMoveInstance,
	get_children = toolGetChildren,
	get_attributes = toolGetAttributes,
	set_attributes = toolSetAttributes,
	add_tag = toolAddTag,
	remove_tag = toolRemoveTag,
	get_tags = toolGetTags,
	create_script = toolCreateScript,
	call_method = toolCallMethod,
	clear_children = toolClearChildren,
	count_instances = toolCountInstances,
	group_instances = toolGroupInstances,
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

log("Rublox загружен. URL и токен встроены — нажмите Connect.")

