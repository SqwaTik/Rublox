// Библиотека готовых Lua-шаблонов для Roblox.
// Вместо генерации частых конструкций с нуля (что тратит токены) модель
// вызывает use_template и получает проверенный блок кода.

export const TEMPLATES = {
  platformer_character: {
    title: 'Базовый платформер: прыгающий игрок',
    description: 'Настройка управления и прыжка для персонажа платформера.',
    params: { jumpPower: 'сила прыжка (число, по умолчанию 50)', walkSpeed: 'скорость (по умолчанию 16)' },
    build: (p = {}) => `
local Players = game:GetService("Players")
local function setup(character)
\tlocal humanoid = character:WaitForChild("Humanoid")
\thumanoid.UseJumpPower = true
\thumanoid.JumpPower = ${Number(p.jumpPower) || 50}
\thumanoid.WalkSpeed = ${Number(p.walkSpeed) || 16}
end
Players.PlayerAdded:Connect(function(player)
\tplayer.CharacterAdded:Connect(setup)
end)`.trim(),
  },

  npc_move_to: {
    title: 'Отправить NPC к координатам',
    description: 'NPC с Humanoid идёт в заданную точку.',
    params: { x: 'X', y: 'Y', z: 'Z', npcName: 'имя модели NPC в Workspace' },
    build: (p = {}) => `
local npc = workspace:FindFirstChild("${p.npcName || 'NPC'}")
if npc then
\tlocal humanoid = npc:FindFirstChildOfClass("Humanoid")
\tif humanoid then
\t\thumanoid:MoveTo(Vector3.new(${Number(p.x) || 0}, ${Number(p.y) || 0}, ${Number(p.z) || 0}))
\tend
end`.trim(),
  },

  race_checkpoints: {
    title: 'Гонка по чекпоинтам',
    description: 'Создаёт чекпоинты и засекает прохождение круга по точкам.',
    params: { count: 'число чекпоинтов (по умолчанию 4)', spacing: 'шаг между ними (по умолчанию 40)' },
    build: (p = {}) => {
      const count = Number(p.count) || 4;
      const spacing = Number(p.spacing) || 40;
      return `
local folder = Instance.new("Folder")
folder.Name = "Checkpoints"
folder.Parent = workspace
for i = 1, ${count} do
\tlocal cp = Instance.new("Part")
\tcp.Name = "Checkpoint" .. i
\tcp.Anchored = true
\tcp.Size = Vector3.new(8, 1, 8)
\tcp.Position = Vector3.new(${spacing} * i, 1, 0)
\tcp.BrickColor = BrickColor.new("Bright yellow")
\tcp.Parent = folder
end
print("Создано ${count} чекпоинтов")`.trim();
    },
  },

  leaderboard_points: {
    title: 'Лидерборд с очками',
    description: 'Добавляет leaderstats с числовым значением Points каждому игроку.',
    params: { statName: 'имя статистики (по умолчанию Points)' },
    build: (p = {}) => `
local Players = game:GetService("Players")
Players.PlayerAdded:Connect(function(player)
\tlocal stats = Instance.new("Folder")
\tstats.Name = "leaderstats"
\tstats.Parent = player
\tlocal points = Instance.new("IntValue")
\tpoints.Name = "${p.statName || 'Points'}"
\tpoints.Value = 0
\tpoints.Parent = stats
end)`.trim(),
  },

  sprint_on_shift: {
    title: 'Спринт на Left Shift',
    description: 'Постоянный LocalScript в StarterPlayerScripts: ускорение по Shift.',
    params: { sprintSpeed: 'скорость бега (по умолчанию 28)', walkSpeed: 'обычная (16)' },
    build: (p = {}) => {
      const sprint = Number(p.sprintSpeed) || 28;
      const walk = Number(p.walkSpeed) || 16;
      return `
local sps = game:GetService("StarterPlayer").StarterPlayerScripts
local existing = sps:FindFirstChild("SprintController")
if existing then existing:Destroy() end
local s = Instance.new("LocalScript")
s.Name = "SprintController"
s.Source = [==[
local UIS = game:GetService("UserInputService")
local Players = game:GetService("Players")
local SPRINT = ${sprint}
local WALK = ${walk}
local function humanoid()
\tlocal char = Players.LocalPlayer.Character
\treturn char and char:FindFirstChildOfClass("Humanoid")
end
UIS.InputBegan:Connect(function(input, gp)
\tif gp then return end
\tif input.KeyCode == Enum.KeyCode.LeftShift then
\t\tlocal h = humanoid(); if h then h.WalkSpeed = SPRINT end
\tend
end)
UIS.InputEnded:Connect(function(input)
\tif input.KeyCode == Enum.KeyCode.LeftShift then
\t\tlocal h = humanoid(); if h then h.WalkSpeed = WALK end
\tend
end)
]==]
s.Parent = sps
print("SprintController установлен, Shift = " .. SPRINT)`.trim();
    },
  },

  click_to_collect: {
    title: 'Сбор предмета по клику',
    description: 'Part с ClickDetector, начисляет очки и исчезает по клику.',
    params: { reward: 'награда за клик (по умолчанию 1)', statName: 'имя статистики (Points)' },
    build: (p = {}) => `
local part = Instance.new("Part")
part.Name = "Collectible"
part.Anchored = true
part.Size = Vector3.new(4, 4, 4)
part.Position = Vector3.new(0, 5, 0)
part.BrickColor = BrickColor.new("Lime green")
part.Parent = workspace
local click = Instance.new("ClickDetector")
click.Parent = part
click.MouseClick:Connect(function(player)
\tlocal stats = player:FindFirstChild("leaderstats")
\tif stats and stats:FindFirstChild("${p.statName || 'Points'}") then
\t\tstats["${p.statName || 'Points'}"].Value += ${Number(p.reward) || 1}
\tend
\tpart:Destroy()
end)`.trim(),
  },
};

export function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({
    id,
    title: t.title,
    description: t.description,
    params: t.params || {},
  }));
}

export function getTemplate(id) {
  return TEMPLATES[id] || null;
}

export function renderTemplate(id, params) {
  const t = TEMPLATES[id];
  if (!t) throw new Error(`Шаблон "${id}" не найден`);
  return t.build(params || {});
}
