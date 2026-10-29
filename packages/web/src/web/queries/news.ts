import { useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

export const useNewsOverview = () => useQuery(orpc.news.overview.queryOptions({ refetchInterval: 60_000 }));