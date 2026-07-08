import type { StartupApiSetRemoteAccessRequest } from '@jellyfin/sdk/lib/generated-client/api/startup-api';
import { getStartupApi } from '@jellyfin/sdk/lib/utils/api/startup-api';
import { useMutation } from '@tanstack/react-query';
import { type JellyfinApiContext, useApi } from 'hooks/useApi';

const setRemoteAccess = async (
    apiContext: JellyfinApiContext,
    params: StartupApiSetRemoteAccessRequest
) => {
    const { api } = apiContext;

    if (!api) throw new Error('[setRemoteAccess] No API instance available');

    // NOTE: setRemoteAccess is deprecated server-side but has no replacement endpoint yet
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return getStartupApi(api).setRemoteAccess(params);
};

export const useSetRemoteAccess = () => {
    const apiContext = useApi();

    return useMutation({
        mutationFn: (params: StartupApiSetRemoteAccessRequest) => setRemoteAccess(apiContext, params)
    });
};
