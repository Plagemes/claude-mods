import type { Sheet } from '../sheet'

export const kubectl: Sheet = {
  topic: 'kubectl',
  title: 'kubectl',
  aliases: ['k8s', 'kube', 'k'],
  summary: 'contexts, get/describe/logs, exec, apply, rollouts, debugging',
  markdown: `## Context and namespace
    kubectl config get-contexts                           list clusters you can talk to
    kubectl config use-context <name>                     switch cluster
    kubectl config set-context --current --namespace=<ns>  change the default namespace
    -n <ns>   -A                                          on any command: one namespace, all namespaces

## Get
    kubectl get pods -o wide                              pods with node and IP
    kubectl get pods -l app=web                           filter by label
    kubectl get pods -w                                   watch for changes
    kubectl get <kind> <name> -o yaml                     full definition (-o json too)
    kubectl get pods -o jsonpath='{.items[*].metadata.name}'  pick fields
    kubectl get events --sort-by=.lastTimestamp           recent events, oldest first
    kubectl api-resources                                 every kind this cluster knows

## Inspect
    kubectl describe pod <name>                   details and events: first stop for a failing pod
    kubectl logs <pod> -f --tail=100              follow the last 100 lines
    kubectl logs <pod> -c <container> --previous  logs of the crashed container instance
    kubectl logs -l app=web --all-containers      logs from every pod with a label
    kubectl top pods | nodes                      CPU and memory (needs metrics-server)
    kubectl explain pod.spec.containers           built-in field documentation

## Run and connect
    kubectl exec -it <pod> -- sh                          shell in a container
    kubectl port-forward svc/<name> 8080:80               local port 8080 to the service's port 80
    kubectl cp <pod>:/path ./local                        copy files out (or in)
    kubectl run tmp --rm -it --restart=Never --image=busybox -- sh  throwaway debug pod

## Create and change
    kubectl apply -f file.yaml                        create or update from a file (-f dir/, -k for kustomize)
    kubectl diff -f file.yaml                         what apply would change
    kubectl delete -f file.yaml                       delete what a file defines
    kubectl delete pod <name>                         delete one pod (a controller recreates it)
    kubectl edit deploy <name>                        edit the live object in $EDITOR
    kubectl create deployment <name> --image=<image>  quick deployment
    kubectl label pod <name> env=dev                  add a label
    kubectl apply --dry-run=server -f file.yaml       validate against the cluster without changing it

## Rollouts and scaling
    kubectl scale deploy <name> --replicas=3              change the number of pods
    kubectl rollout status deploy/<name>                  wait for a rollout to finish
    kubectl rollout history deploy/<name>                 revisions
    kubectl rollout undo deploy/<name>                    go back to the previous revision
    kubectl rollout restart deploy/<name>                 restart all pods gradually
    kubectl set image deploy/<name> <container>=<image:tag>  change the image

## Cluster and access
    kubectl cordon | uncordon <node>                      stop or resume scheduling onto a node
    kubectl drain <node> --ignore-daemonsets              evict pods before maintenance
    kubectl auth can-i create pods                        check your permissions
    kubectl get secret <name> -o jsonpath='{.data.key}' | base64 -d  read one secret value
`,
}
