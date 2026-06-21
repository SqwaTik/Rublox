// Проекты: имя + проектная папка + общие заметки (память проекта). Активный
// проект подмешивается в системный промпт ВО ВСЕХ чатах — поэтому ИИ «помнит»
// контекст проекта в любом чате. Хранится в app.json:
//   projects = [{ id, name, folder, notes }], activeProjectId = id|null

import { appConfigGet, appConfigSet } from './app-config.js';
import { randomBytes } from 'node:crypto';

function load() {
  const projects = appConfigGet('projects', []);
  return Array.isArray(projects) ? projects : [];
}
function save(projects) { appConfigSet('projects', projects); }

export function listProjects() {
  return load();
}

export function getActiveProject() {
  const id = appConfigGet('activeProjectId', null);
  if (!id) return null;
  return load().find((p) => p.id === id) || null;
}

export function setActiveProject(id) {
  appConfigSet('activeProjectId', id || null);
  return getActiveProject();
}

export function createProject({ name, folder }) {
  const projects = load();
  const id = 'prj_' + randomBytes(5).toString('hex');
  const project = {
    id,
    name: String(name || 'Проект').slice(0, 80),
    folder: String(folder || '').slice(0, 500),
    notes: '',
  };
  projects.push(project);
  save(projects);
  setActiveProject(id); // новый проект сразу активен
  return project;
}

export function updateProject(id, patch) {
  const projects = load();
  const p = projects.find((x) => x.id === id);
  if (!p) return null;
  if (patch.name != null) p.name = String(patch.name).slice(0, 80);
  if (patch.folder != null) p.folder = String(patch.folder).slice(0, 500);
  if (patch.notes != null) p.notes = String(patch.notes).slice(0, 8000);
  save(projects);
  return p;
}

export function deleteProject(id) {
  const projects = load().filter((p) => p.id !== id);
  save(projects);
  if (appConfigGet('activeProjectId', null) === id) setActiveProject(null);
  return true;
}

// Текст контекста проекта для системного промпта (память во всех чатах).
export function projectPromptBlock() {
  const p = getActiveProject();
  if (!p) return '';
  let block = `ПРОЕКТ: «${p.name}».`;
  if (p.folder) block += ` Проектная папка: ${p.folder} (работай с файлами здесь по умолчанию).`;
  if (p.notes && p.notes.trim()) block += `\nПамять проекта (общая для всех чатов):\n${p.notes.trim()}`;
  return block;
}
