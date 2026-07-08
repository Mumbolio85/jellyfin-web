import type { StartupApiUpdateStartupUserRequest } from '@jellyfin/sdk/lib/generated-client/api/startup-api';
import { getStartupApi } from '@jellyfin/sdk/lib/utils/api/startup-api';
import { useMutation } from '@tanstack/react-query';
import { type JellyfinApiContext, useApi } from 'hooks/useApi';

const updateStartupUser = async (
    apiContext: JellyfinApiContext,
    params: StartupApiUpdateStartupUserRequest
) => {
    const { api } = apiContext;

    if (!api) throw new Error('[updateStartupUser] No API instance available');

    return getStartupApi(api).updateStartupUser(params);
};

export const useUpdateStartupUser = () => {
    const apiContext = useApi();

    return useMutation({
        mutationFn: (params: StartupApiUpdateStartupUserRequest) =>
            updateStartupUser(apiContext, params)
    });
};
