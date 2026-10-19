// Fixed project list for the Kanban built-in extension (CONTRACT_KANBAN §3).
// The ids are immutable route keys; changing them is a breaking contract change.

export const PROJECT_IDS = [
  'projeto_jev',
  'jez_collections',
  'panela_sobra',
  'faturamento_medico',
  'predictera',
  'opencode_chambers_harness',
  'ensemble_room_lowcost',
] as const;

export type ProjectId = (typeof PROJECT_IDS)[number];

export interface ProjectDefinition {
  readonly id: ProjectId;
  readonly title: string;
  readonly path: string;
}

export const PROJECTS: readonly ProjectDefinition[] = [
  { id: 'projeto_jev', title: 'agent_quality_guard', path: '/home/maiteuxzanela/projeto JEV' },
  { id: 'jez_collections', title: 'JEZ Collections', path: '/mnt/94CCB337CCB3130A/JEZ collections' },
  { id: 'panela_sobra', title: 'Panela de Sobra', path: '/home/maiteuxzanela/PanelaBuild' },
  { id: 'faturamento_medico', title: 'Faturamento Médico', path: '/mnt/94CCB337CCB3130A/Faturamento' },
  { id: 'predictera', title: 'Predictera', path: '/mnt/94CCB337CCB3130A/predictera' },
  { id: 'opencode_chambers_harness', title: 'OpenCode Chambers Harness', path: '/mnt/94CCB337CCB3130A/opencode_chambers_harness' },
  { id: 'ensemble_room_lowcost', title: 'Ensemble Hardened', path: '/mnt/94CCB337CCB3130A/ensemble-room-lowcost' },
];

export const findProject = (id: string): ProjectDefinition | null =>
  PROJECTS.find((project) => project.id === id) ?? null;

export const kanbanFilePath = (project: ProjectDefinition): string =>
  `${project.path}/kanban.json`;
