import { getStartupApi } from '@jellyfin/sdk/lib/utils/api/startup-api';
import { useQuery } from '@tanstack/react-query';
import { type JellyfinApiContext, useApi } from 'hooks/useApi';
import type { AxiosRequestConfig } from 'axios';

export const QUERY_KEY = 'StartupConfiguration';

export const fetchConfiguration = async (apiContext: JellyfinApiContext, options?: AxiosRequestConfig) => {
    const { api } = apiContext;

    if (!api) throw new Error('[fetchConfiguration] No API instance available');

    // NOTE: getStartupConfiguration is deprecated server-side but has no replacement endpoint yet
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const response = await getStartupApi(api).getStartupConfiguration(options);

    return response.data;
};

export const useStartupConfiguration = () => {
    const apiContext = useApi();

    return useQuery({
        queryKey: [ QUERY_KEY ],
        queryFn: ({ signal }) => fetchConfiguration(apiContext, { signal }),
        enabled: !!apiContext.api
    });
};
