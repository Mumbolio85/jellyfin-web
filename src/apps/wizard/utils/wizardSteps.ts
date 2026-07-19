// Reordering this list drives the progress indicator and Previous/Next navigation for every step.
const WIZARD_STEPS = [
    { id: 'start', path: '/wizard/start' },
    { id: 'user', path: '/wizard/user' },
    { id: 'additional-users', path: '/wizard/additional-users' },
    { id: 'remote', path: '/wizard/remote' },
    { id: 'advanced', path: '/wizard/advanced' },
    { id: 'settings', path: '/wizard/settings' },
    { id: 'library', path: '/wizard/library' },
    { id: 'finish', path: '/wizard/finish' }
] as const;

export type WizardStepId = typeof WIZARD_STEPS[number]['id'];

export const TOTAL_WIZARD_STEPS = WIZARD_STEPS.length;

function indexOfStep(stepId: string) {
    return WIZARD_STEPS.findIndex(step => step.id === stepId);
}

export function getWizardStepNumber(stepId: string | undefined) {
    if (!stepId) return null;
    const index = indexOfStep(stepId);
    return index === -1 ? null : index + 1;
}

export function getStepPath(stepId: WizardStepId) {
    return WIZARD_STEPS.find(step => step.id === stepId)!.path;
}

export function getPreviousStepPath(stepId: WizardStepId) {
    const index = indexOfStep(stepId);
    return index > 0 ? WIZARD_STEPS[index - 1].path : undefined;
}

export function getNextStepPath(stepId: WizardStepId) {
    const index = indexOfStep(stepId);
    return index !== -1 && index < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[index + 1].path : undefined;
}

export function parsePort(str: string | undefined) {
    return Number.parseInt(str ?? '', 10);
}
