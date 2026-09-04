/**
 * Client-side access to the AI surface.
 *
 * The one fact this module exists to keep straight: **a degraded answer is a
 * 200.** `api.ai.*` resolves with `result: null` when the model is unavailable,
 * times out, or produces something the schema would not accept, so `isError` on
 * these mutations means the *request* failed — rate limited, forbidden, or a run
 * id from another organisation — and never "the AI had nothing to say". Panels
 * render the first case from `failure` and the second from `response.status`, and
 * mixing them up is how a working page ends up looking broken.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { useAuth } from '@/providers/AuthProvider';
import type { AiResponse } from '@eclens/shared';

/**
 * Deployment configuration, not organisational data: it changes when the server
 * is redeployed with or without a key, which is not something a page needs to
 * rediscover on every focus. Cached long enough that the AI entry points mounted
 * across the app cost one request between them.
 */
export function useAiStatus() {
  const { can } = useAuth();
  const permitted = can('ai:use');

  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api.ai.status(),
    enabled: permitted,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    data: status.data,
    isLoading: status.isLoading && permitted,
    isError: status.isError,
    refetch: status.refetch,
    /** False while loading too, so a panel does not flash "AI unavailable". */
    available: permitted && (status.data?.availability.available ?? false),
    /** The role cannot use AI at all, so no entry point should render. */
    permitted,
    limits: status.data?.limits,
    disclaimer: status.data?.disclaimer,
  };
}

/**
 * Wraps one AI feature call.
 *
 * The previous answer is kept while a re-run is in flight rather than blanked:
 * for a call that takes seconds, clearing the panel the moment the user clicks
 * "Explain again" reads as a failure. `reset` is exposed for the panels that do
 * want to clear, such as when the exposure being explained changes.
 */
export function useAiFeature<TInput, TResult>(call: (input: TInput) => Promise<AiResponse<TResult>>) {
  const mutation = useMutation({ mutationFn: call });

  const failure = mutation.error
    ? mutation.error instanceof ApiError
      ? mutation.error.isForbidden
        ? 'Your role cannot use this AI feature.'
        : mutation.error.message
      : 'The request did not reach the server.'
    : null;

  return {
    response: mutation.data ?? null,
    failure,
    isPending: mutation.isPending,
    run: mutation.mutate,
    reset: mutation.reset,
  };
}
