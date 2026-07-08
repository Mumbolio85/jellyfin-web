import { getStartupApi } from '@jellyfin/sdk/lib/utils/api/startup-api';
import { useQuery } from '@tanstack/react-query';
import { type JellyfinApiContext, useApi } from 'hooks/useApi';
import type { AxiosRequestConfig } from 'axios';

export const QUERY_KEY = 'StartupUser';

export const fetchStartupUser = async (apiContext: JellyfinApiContext, options?: AxiosRequestConfig) => {
    const { api } = apiContext;

    if (!api) throw new Error('[fetchStartupUser] No API instance available');

    // NOTE: getFirstUser is deprecated server-side but has no replacement endpoint yet
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const response = await getStartupApi(api).getFirstUser(options);

    return response.data;
};

export const useStartupUser = () => {
    const apiContext = useApi();

    return useQuery({
        queryKey: [ QUERY_KEY ],
        queryFn: ({ signal }) => fetchStartupUser(apiContext, { signal }),
        enabled: !!apiContext.api
    });
};
