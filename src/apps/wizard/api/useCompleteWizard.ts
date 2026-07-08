import { getStartupApi } from '@jellyfin/sdk/lib/utils/api/startup-api';
import { useMutation } from '@tanstack/react-query';
import { type JellyfinApiContext, useApi } from 'hooks/useApi';

const completeWizard = async (apiContext: JellyfinApiContext) => {
    const { api } = apiContext;

    if (!api) throw new Error('[completeWizard] No API instance available');

    return getStartupApi(api).completeWizard();
};

export const useCompleteWizard = () => {
    const apiContext = useApi();

    return useMutation({
        mutationFn: () => completeWizard(apiContext)
    });
};
