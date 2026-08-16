import './skills'

export { createSkillsRegistry, provideSkills, UnknownSkillError } from './skills'
export type { Skill, SkillsService, Unregister } from './skills'
export { discoverSkills, skillsFromDirectory } from './fs-discovery'
export type { SkillsFromDirectoryOptions } from './fs-discovery'
export { createSkillTool, SKILL_TOOL_DECLARATION, skillTool } from './tool'
