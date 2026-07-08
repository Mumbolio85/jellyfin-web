import type { StartupApiUpdateInitialConfigurationRequest } from '@jellyfin/sdk/lib/generated-client/api/startup-api';
import { getStartupApi } from '@jellyfin/sdk/lib/utils/api/startup-api';
import { useMutation } from '@tanstack/react-query';
import { type JellyfinApiContext, useApi } from 'hooks/useApi';

const updateInitialConfiguration = async (
    apiContext: JellyfinApiContext,
    params: StartupApiUpdateInitialConfigurationRequest
) => {
    const { api } = apiContext;

    if (!api) throw new Error('[updateInitialConfiguration] No API instance available');

    // NOTE: updateInitialConfiguration is deprecated server-side but has no replacement endpoint yet
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return getStartupApi(api).updateInitialConfiguration(params);
};

export const useUpdateInitialConfiguration = () => {
    const apiContext = useApi();

    return useMutation({
        mutationFn: (params: StartupApiUpdateInitialConfigurationRequest) =>
            updateInitialConfiguration(apiContext, params)
    });
};
