# Справочник Luau и Roblox API

Полный практический справочник по языку Luau и движку Roblox для AI-ассистента
Rublox. Каждый раздел (`## Заголовок`) — отдельная тема, доступная через инструмент
`luau_reference(topic)`. Это знание о реальной платформе Roblox; используй его,
когда пишешь или правишь код в Studio.

## Основы Luau

Luau — диалект Lua 5.1 с градуальной типизацией, используемый в Roblox.

```lua
-- Переменные и типы
local n: number = 42          -- число (double)
local s: string = "привет"    -- строка
local b: boolean = true        -- булево
local nothing = nil            -- отсутствие значения
local t = {}                   -- таблица (массив + словарь)

-- Строки
local len = #s                 -- длина (для UTF-8 байт)
local up = string.upper(s)
local sub = string.sub(s, 1, 3)
local fmt = string.format("%d очков, %.2f", 10, 3.14159)
local parts = string.split("a,b,c", ",")  -- {"a","b","c"}
local found = string.find(s, "вет")        -- индекс или nil

-- Конкатенация через ..
local msg = "У игрока " .. n .. " очков"

-- Числа
math.floor(3.7); math.ceil(3.2); math.abs(-5); math.random(1, 10)
math.clamp(x, 0, 100); math.round(2.5); math.huge; math.pi
```

Управляющие конструкции:

```lua
if x > 10 then
    -- ...
elseif x > 5 then
    -- ...
else
    -- ...
end

for i = 1, 10 do print(i) end              -- числовой цикл
for i = 10, 1, -1 do print(i) end           -- с шагом
for index, value in ipairs(array) do end    -- массив по порядку
for key, value in pairs(dict) do end        -- словарь
while condition do end
repeat until condition

-- continue в Luau:
for _, v in ipairs(t) do
    if v < 0 then continue end
    print(v)
end
```

Функции:

```lua
local function add(a: number, b: number): number
    return a + b
end

-- Вариативные аргументы
local function sum(...)
    local total = 0
    for _, v in ipairs({...}) do total += v end
    return total
end

-- Множественный возврат
local function minmax(t) return math.min(table.unpack(t)), math.max(table.unpack(t)) end
local lo, hi = minmax({3, 1, 2})
```

Составное присваивание Luau: `+=  -=  *=  /=  //=  %=  ^=  ..=`.

## Таблицы

Таблица — единственная структура данных Lua: массив и словарь одновременно.

```lua
local arr = {10, 20, 30}        -- индексы 1,2,3 (нумерация с 1!)
arr[#arr + 1] = 40              -- добавить в конец
table.insert(arr, 50)           -- то же
table.insert(arr, 1, 5)         -- вставить по индексу
table.remove(arr, 2)            -- удалить по индексу
local n = #arr                  -- длина массивной части

local dict = { name = "Bob", hp = 100 }
dict.level = 5                  -- dict["level"] = 5
dict["key"] = nil               -- удалить ключ

table.sort(arr)                          -- по возрастанию
table.sort(arr, function(a, b) return a > b end)  -- кастом
table.find(arr, 20)             -- индекс значения или nil
table.concat({"a","b"}, "-")   -- "a-b"
table.clear(t); table.clone(t)  -- очистка / поверхностная копия

-- "Класс" через метатаблицы
local Animal = {}
Animal.__index = Animal
function Animal.new(name)
    return setmetatable({ name = name }, Animal)
end
function Animal:speak()          -- метод (self неявно)
    print(self.name .. " издаёт звук")
end
local dog = Animal.new("Рекс")
dog:speak()
```

## Иерархия Instance и пути

Всё в игре — это `Instance` (объект) в дереве `game` (DataModel). Каждый объект имеет
`.Name`, `.ClassName`, `.Parent` и детей.

```lua
local part = workspace.Baseplate        -- ребёнок по имени (ошибка, если нет)
local part = workspace:FindFirstChild("Baseplate")        -- nil, если нет
local part = workspace:FindFirstChild("Coin", true)        -- рекурсивно
local hum = char:FindFirstChildOfClass("Humanoid")
local hum = char:FindFirstChildWhichIsA("Humanoid")        -- учитывает наследование
local obj = workspace:WaitForChild("Map", 10)              -- ждать (таймаут сек)

for _, child in ipairs(part:GetChildren()) do end          -- прямые дети
for _, d in ipairs(workspace:GetDescendants()) do end      -- все потомки

local full = part:GetFullName()         -- "Workspace.Folder.Part"
part.Parent = workspace                 -- переместить
part:Destroy()                          -- удалить навсегда
local copy = part:Clone()               -- копия (Parent = nil)
part:IsA("BasePart")                    -- проверка класса/наследования
part:IsDescendantOf(workspace)

-- Создание объекта
local p = Instance.new("Part")
p.Name = "MyPart"
p.Parent = workspace                    -- Parent ставь ПОСЛЕДНИМ (оптимизация)
```

## Сервисы (game services)

Доступ только через `game:GetService(...)`. Основные:

- **Workspace** (`workspace`) — 3D-мир: части, модели, террейн. Реплицируется.
- **Players** — игроки; `Players.PlayerAdded`, `Players.LocalPlayer` (только клиент).
- **ReplicatedStorage** — общие данные/модули/RemoteEvent для сервера и клиента.
- **ReplicatedFirst** — грузится первым на клиенте (лоадскрины).
- **ServerScriptService** — серверные `Script`; недоступно клиенту.
- **ServerStorage** — серверные ассеты; не реплицируется.
- **StarterGui** — копируется в `PlayerGui` каждому игроку (UI).
- **StarterPack** — инструменты (Tool), выдаются при спавне.
- **StarterPlayer.StarterPlayerScripts** — `LocalScript`, один раз на игрока.
- **StarterPlayer.StarterCharacterScripts** — скрипты в каждый новый персонаж.
- **Lighting** — свет, атмосфера, эффекты постобработки.
- **SoundService**, **TweenService**, **RunService**, **UserInputService**,
  **ContextActionService**, **CollectionService**, **PhysicsService**,
  **HttpService**, **DataStoreService**, **MarketplaceService**, **Debris**,
  **PathfindingService**, **TeleportService**, **TextChatService**.

```lua
local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
```

## Скрипты и контексты выполнения

- **Script** — серверный код. Запускается там, где `RunContext = Legacy` и объект в
  серверной локации (ServerScriptService, Workspace). С `RunContext = Server` —
  где угодно.
- **LocalScript** — клиентский код. Работает только в `PlayerGui`,
  `StarterPlayerScripts`, `StarterCharacterScripts`, `ReplicatedFirst`, в Tool у игрока.
- **ModuleScript** — переиспользуемый модуль, возвращает значение через `require`.

```lua
-- ModuleScript в ReplicatedStorage с именем "Util"
local Util = {}
function Util.greet(name) return "Привет, " .. name end
return Util

-- Использование (сервер или клиент)
local Util = require(game.ReplicatedStorage.Util)
print(Util.greet("Мир"))
```

Проверка стороны: `RunService:IsServer()`, `RunService:IsClient()`,
`RunService:IsStudio()`, `RunService:IsRunning()`.

## События (signals) и связи

```lua
-- Подключение
local conn = part.Touched:Connect(function(hit)
    local hum = hit.Parent:FindFirstChildOfClass("Humanoid")
    if hum then hum:TakeDamage(10) end
end)
conn:Disconnect()                       -- отключить

part.Touched:Once(function(hit) end)    -- сработает один раз
part:GetPropertyChangedSignal("Position"):Connect(function() end)

-- Частые события
Players.PlayerAdded:Connect(function(player) end)
Players.PlayerRemoving:Connect(function(player) end)
player.CharacterAdded:Connect(function(character) end)
humanoid.Died:Connect(function() end)
RunService.Heartbeat:Connect(function(dt) end)   -- каждый кадр после физики
RunService.RenderStepped:Connect(function(dt) end) -- клиент, до рендера

task.wait(2)                            -- неблокирующая пауза (предпочитай wait())
task.spawn(function() end)              -- запустить корутину
task.delay(3, function() end)           -- отложенный вызов
```

## BasePart, физика и CFrame

```lua
local p = Instance.new("Part")
p.Size = Vector3.new(4, 1, 2)
p.Position = Vector3.new(0, 10, 0)       -- центр объекта
p.Anchored = true                        -- не падает от физики
p.CanCollide = true                      -- столкновения
p.Material = Enum.Material.Neon
p.Color = Color3.fromRGB(255, 80, 80)
p.Transparency = 0.2

-- CFrame = позиция + ориентация
p.CFrame = CFrame.new(0, 10, 0)
p.CFrame = CFrame.new(pos) * CFrame.Angles(0, math.rad(90), 0)
p.CFrame = CFrame.lookAt(eyePos, targetPos)
local moved = p.CFrame * CFrame.new(0, 0, -5)   -- локально вперёд

-- Vector3
local v = Vector3.new(1, 2, 3)
v.Magnitude; v.Unit; v:Dot(other); v:Cross(other)
v:Lerp(target, 0.5)

-- Силы/движение (вместо ручного перемещения)
local bv = Instance.new("BodyVelocity")  -- устаревшее; новое: VectorForce/LinearVelocity
local lv = Instance.new("LinearVelocity")

-- Raycast
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.FilterDescendantsInstances = { character }
local result = workspace:Raycast(origin, direction * 100, params)
if result then print(result.Instance, result.Position, result.Normal) end
```

## Персонаж и Humanoid

```lua
local char = player.Character or player.CharacterAdded:Wait()
local hum = char:WaitForChild("Humanoid")
local hrp = char:WaitForChild("HumanoidRootPart")

hum.WalkSpeed = 24
hum.JumpPower = 60          -- при UseJumpPower = true
hum.JumpHeight = 7.2        -- при UseJumpPower = false (по умолчанию)
hum.MaxHealth = 200; hum.Health = 200
hum:TakeDamage(25)
hum:MoveTo(Vector3.new(0, 0, 50))
hum.Died:Connect(function() end)
hum:GetState(); hum:ChangeState(Enum.HumanoidStateType.Jumping)

-- Телепорт персонажа
char:PivotTo(CFrame.new(0, 50, 0))     -- или hrp.CFrame = ...
```

## RemoteEvent и RemoteFunction (клиент ↔ сервер)

Хранить в `ReplicatedStorage`. RemoteEvent — без ответа, RemoteFunction — с ответом.

```lua
-- Создание (обычно один раз)
local remote = Instance.new("RemoteEvent")
remote.Name = "BuyItem"
remote.Parent = game.ReplicatedStorage

-- СЕРВЕР: слушать клиента
remote.OnServerEvent:Connect(function(player, itemId)
    -- ВСЕГДА проверяй аргументы от клиента (он может врать)!
    if type(itemId) ~= "string" then return end
    -- ... выдать предмет
end)
remote:FireClient(player, "Победа!")    -- одному
remote:FireAllClients(data)             -- всем

-- КЛИЕНТ: отправить серверу
remote:FireServer("sword_01")
remote.OnClientEvent:Connect(function(message) print(message) end)

-- RemoteFunction (с возвратом)
local rf = Instance.new("RemoteFunction")
rf.OnServerInvoke = function(player, arg) return "ответ" end  -- сервер
local result = rf:InvokeServer("вопрос")                      -- клиент
```

Безопасность: критическую логику (урон, валюта, выдача предметов) держи на СЕРВЕРЕ.
Клиенту не доверяй.

## Ввод игрока (UserInputService / ContextActionService)

```lua
-- LocalScript
local UIS = game:GetService("UserInputService")
UIS.InputBegan:Connect(function(input, gameProcessed)
    if gameProcessed then return end     -- игнор, если ввод ушёл в UI
    if input.KeyCode == Enum.KeyCode.E then print("E нажата") end
    if input.UserInputType == Enum.UserInputType.MouseButton1 then end
end)
UIS.InputEnded:Connect(function(input) end)

-- ContextActionService — привязка действий (удобно для кнопок мобилы)
local CAS = game:GetService("ContextActionService")
CAS:BindAction("Sprint", function(name, state, obj)
    if state == Enum.UserInputState.Begin then end
end, true, Enum.KeyCode.LeftShift)
```

## GUI (интерфейс)

UI кладут в `StarterGui` (на сервере при сборке) — он копируется в `PlayerGui`.
Правит UI обычно `LocalScript`.

```lua
local gui = Instance.new("ScreenGui")
gui.ResetOnSpawn = false
gui.Parent = player.PlayerGui            -- или StarterGui

local frame = Instance.new("Frame")
frame.Size = UDim2.new(0, 200, 0, 100)   -- (xScale,xPx, yScale,yPx)
frame.Position = UDim2.new(0.5, -100, 0.5, -50)
frame.AnchorPoint = Vector2.new(0.5, 0.5)
frame.BackgroundColor3 = Color3.fromRGB(30, 30, 40)
frame.Parent = gui

local btn = Instance.new("TextButton")
btn.Text = "Нажми"
btn.Size = UDim2.fromScale(1, 0.3)
btn.Parent = frame
btn.MouseButton1Click:Connect(function() print("клик") end)

-- Авто-раскладка и скругление
local corner = Instance.new("UICorner"); corner.Parent = frame
local layout = Instance.new("UIListLayout"); layout.Parent = frame
```

Классы UI: `ScreenGui`, `Frame`, `TextLabel`, `TextButton`, `TextBox`, `ImageLabel`,
`ImageButton`, `ScrollingFrame`, `UICorner`, `UIListLayout`, `UIGridLayout`,
`UIPadding`, `UIStroke`, `UIGradient`, `UIAspectRatioConstraint`.

## TweenService (анимация свойств)

```lua
local TweenService = game:GetService("TweenService")
local info = TweenInfo.new(
    1,                                  -- длительность сек
    Enum.EasingStyle.Quad,
    Enum.EasingDirection.Out,
    0,                                  -- повторы
    false,                              -- реверс
    0                                   -- задержка
)
local tween = TweenService:Create(part, info, {
    Position = Vector3.new(0, 20, 0),
    Transparency = 1,
})
tween:Play()
tween.Completed:Connect(function() end)
```

## Данные игроков (DataStore)

Только серверный код. В Studio включи API Services (Game Settings → Security).

```lua
local DSS = game:GetService("DataStoreService")
local store = DSS:GetDataStore("PlayerData")

-- Чтение/запись с защитой через pcall (сетевые ошибки!)
local function load(player)
    local key = "uid_" .. player.UserId
    local ok, data = pcall(function() return store:GetAsync(key) end)
    if ok then return data or { coins = 0 } end
    warn("DataStore load fail:", data)
    return nil
end
local function save(player, data)
    pcall(function()
        store:UpdateAsync("uid_" .. player.UserId, function(old) return data end)
    end)
end

Players.PlayerRemoving:Connect(function(p) save(p, getData(p)) end)
game:BindToClose(function() --[[ сохранить всех при выключении ]] end)
```

Используй `UpdateAsync` вместо `SetAsync` для безопасных обновлений. Не вызывай
DataStore чаще лимитов (≈ раз в 6 сек на ключ).

## leaderstats (таблица лидеров)

```lua
Players.PlayerAdded:Connect(function(player)
    local stats = Instance.new("Folder")
    stats.Name = "leaderstats"           -- ИМЕННО так — для встроенного списка
    stats.Parent = player
    local coins = Instance.new("IntValue")
    coins.Name = "Coins"
    coins.Value = 0
    coins.Parent = stats
end)
```

## Звук

```lua
local sound = Instance.new("Sound")
sound.SoundId = "rbxassetid://1234567890"
sound.Volume = 0.5
sound.Parent = part                      -- 3D-звук от части; в SoundService — 2D
sound:Play()
sound.Ended:Connect(function() sound:Destroy() end)
```

## Распространённые ошибки и правила

- Индексация таблиц с **1**, не с 0.
- `Instance.new("Part")` затем настройка, и `.Parent` — **в самом конце**.
- `WaitForChild` на клиенте для объектов, которые могут ещё не реплицироваться.
- Серверная логика — в `Script` (ServerScriptService); клиентская — в `LocalScript`.
- `Players.LocalPlayer` есть только на клиенте (в LocalScript).
- Любой сетевой вызов (DataStore, HttpService, MarketplaceService) оборачивай в `pcall`.
- Не доверяй аргументам из `OnServerEvent` — проверяй типы и права.
- Для пауз — `task.wait()`, для отложенного запуска — `task.spawn`/`task.delay`.
- Удаляй временные объекты (`Debris:AddItem(obj, 5)` или `:Destroy()`), не копи мусор.
- `print`, `warn`, `error` выводят в Output; `error` прерывает поток (лови pcall).

## Библиотека task (планировщик)

```lua
task.wait(1)                       -- точная пауза (лучше старого wait())
task.spawn(function() ... end)     -- запустить корутину СРАЗУ, не блокируя
task.defer(function() ... end)     -- запустить в конце текущего кадра
task.delay(2, function() ... end)  -- запустить через 2 сек
-- Никогда не используй while true do end без task.wait() — заморозит поток.
```

## RunService (циклы кадра)

```lua
local RunService = game:GetService("RunService")
-- Heartbeat: каждый кадр ПОСЛЕ физики (сервер и клиент). dt — время кадра.
RunService.Heartbeat:Connect(function(dt) end)
-- RenderStepped: каждый кадр ДО рендера, ТОЛЬКО клиент (камера, плавность).
RunService.RenderStepped:Connect(function(dt) end)
-- PreSimulation/PostSimulation — современные имена для физики.
-- Отключай соединение, когда не нужно: local c = ...:Connect(...); c:Disconnect()
```

## Raycasting (лучи)

```lua
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.FilterDescendantsInstances = { character }   -- игнорировать себя
local origin = part.Position
local direction = Vector3.new(0, -50, 0)            -- длина = величина вектора
local result = workspace:Raycast(origin, direction, params)
if result then
	print(result.Instance, result.Position, result.Normal, result.Material)
end
-- Blockcast/Spherecast — объёмные версии. Direction задаёт И сторону, И дальность.
```

## CollectionService (теги)

```lua
local CollectionService = game:GetService("CollectionService")
CollectionService:AddTag(part, "Damage")
for _, obj in CollectionService:GetTagged("Damage") do
	-- применяем поведение ко всем помеченным
end
-- Реагировать на появление новых помеченных объектов:
CollectionService:GetInstanceAddedSignal("Damage"):Connect(function(obj) end)
-- Паттерн «тег → поведение» удобнее, чем искать объекты по имени.
```

## Атрибуты (Attributes)

```lua
part:SetAttribute("Health", 100)        -- хранит число/строку/bool/Vector3/Color3...
local hp = part:GetAttribute("Health")
part:GetAttributeChangedSignal("Health"):Connect(function()
	print("HP стал", part:GetAttribute("Health"))
end)
-- Атрибуты видны в Properties и реплицируются — удобнее, чем скрытые Value-объекты.
```

## ModuleScript и require

```lua
-- ModuleScript (напр. в ReplicatedStorage.Modules.Util):
local Util = {}
function Util.add(a, b) return a + b end
return Util
-- Использование из другого скрипта:
local Util = require(game.ReplicatedStorage.Modules.Util)
print(Util.add(2, 3))
-- Модуль выполняется ОДИН раз и кэшируется; общие данные между require — это та же таблица.
```

## ООП на metatables (классы)

```lua
local Animal = {}
Animal.__index = Animal
function Animal.new(name)
	local self = setmetatable({}, Animal)
	self.name = name
	return self
end
function Animal:speak() print(self.name .. " издаёт звук") end
local a = Animal.new("Кот")
a:speak()                               -- двоеточие передаёт self автоматически
```

## Анимации (Animator / AnimationTrack)

```lua
local humanoid = character:WaitForChild("Humanoid")
local animator = humanoid:FindFirstChildOfClass("Animator")
local anim = Instance.new("Animation")
anim.AnimationId = "rbxassetid://123456789"
local track = animator:LoadAnimation(anim)
track.Looped = true
track:Play()
track:AdjustSpeed(1.5)
track:Stop()
-- Грузи анимацию через Animator (не напрямую через Humanoid — устарело).
```

## Констрейнты и физика

```lua
-- Жёсткая сварка двух частей:
local weld = Instance.new("WeldConstraint")
weld.Part0, weld.Part1 = partA, partB
weld.Parent = partA                     -- части должны быть Anchored=false, чтобы двигаться
-- Подвижные соединения работают через Attachment'ы:
local a0 = Instance.new("Attachment", partA)
local a1 = Instance.new("Attachment", partB)
local hinge = Instance.new("HingeConstraint")
hinge.Attachment0, hinge.Attachment1 = a0, a1
hinge.ActuatorType = Enum.ActuatorType.Motor
hinge.MotorMaxTorque = 100000
hinge.AngularVelocity = 2
hinge.Parent = partA
-- Прочие: SpringConstraint, RopeConstraint, RodConstraint, BallSocketConstraint, PrismaticConstraint.
-- Для толчков используй AssemblyLinearVelocity/ApplyImpulse вместо устаревших BodyMovers.
```

## ProximityPrompt и ClickDetector

```lua
local prompt = Instance.new("ProximityPrompt")
prompt.ActionText = "Открыть"
prompt.KeyboardKeyCode = Enum.KeyCode.E
prompt.HoldDuration = 0.5
prompt.Parent = door
prompt.Triggered:Connect(function(player) openDoor(player) end)

local click = Instance.new("ClickDetector")
click.Parent = button
click.MouseClick:Connect(function(player) print(player.Name .. " нажал") end)
```

## PathfindingService (навигация)

```lua
local PathfindingService = game:GetService("PathfindingService")
local path = PathfindingService:CreatePath({ AgentRadius = 2, AgentCanJump = true })
path:ComputeAsync(startPos, targetPos)
if path.Status == Enum.PathStatus.Success then
	for _, wp in path:GetWaypoints() do
		humanoid:MoveTo(wp.Position)
		humanoid.MoveToFinished:Wait()
	end
end
```

## Типы данных (конструкторы)

```lua
Vector3.new(x, y, z)                    -- точка/направление в 3D; .Magnitude, .Unit
Vector2.new(x, y)                       -- 2D (UI, экран)
CFrame.new(x, y, z)                     -- позиция + ориентация; CFrame.Angles(rx,ry,rz) в радианах
CFrame.lookAt(from, to)                 -- смотреть на точку
Color3.fromRGB(255, 128, 0)             -- цвет 0..255; Color3.new(r,g,b) в 0..1
UDim2.new(0.5, 0, 0.5, 0)               -- {scaleX, offsetX, scaleY, offsetY} для UI
UDim.new(scale, offset)
NumberRange.new(min, max)
ColorSequence.new(c0, c1)               -- для частиц/градиентов
Region3.new(min, max)
-- Все эти типы НЕИЗМЕНЯЕМЫ: part.Position += Vector3.new(0,5,0) создаёт новый Vector3.
```

## Полезные сервисы (шпаргалка)

```lua
game:GetService("Players")              -- игроки, .PlayerAdded/.PlayerRemoving, .LocalPlayer
game:GetService("ReplicatedStorage")    -- общие модули/ремоуты (клиент+сервер)
game:GetService("ServerStorage")        -- серверные ассеты (клиенту не видны)
game:GetService("ServerScriptService")  -- серверные Script
game:GetService("Workspace")            -- 3D-мир (= workspace)
game:GetService("Lighting")             -- освещение/атмосфера
game:GetService("TweenService")         -- плавные анимации свойств
game:GetService("UserInputService")     -- ввод (клиент)
game:GetService("RunService")           -- циклы кадра
game:GetService("Debris")               -- авто-удаление: Debris:AddItem(obj, sec)
game:GetService("TeleportService")      -- телепорт между местами
game:GetService("MarketplaceService")   -- покупки, gamepass, проверка владения
game:GetService("HttpService")          -- внешние запросы и JSONEncode/Decode
```
