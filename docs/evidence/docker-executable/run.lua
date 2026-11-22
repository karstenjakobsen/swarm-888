local format = '{"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"exitCode":{{json .State.ExitCode}}}'

return function(args)
  local ids = run("docker", "ps", "-aq", "--filter", "label=" .. args.label)
  local containers = {}
  for id in string.gmatch(ids, "%S+") do
    local output = run("docker", "inspect", "--type", "container", "--format", format, id)
    local container = json_decode(output)
    container.name = string.gsub(container.name, "^/", "")
    if container.state ~= "exited" then
      container.exitCode = nil
    end
    table.insert(containers, container)
  end
  table.sort(containers, function(a, b) return a.name < b.name end)
  return containers
end
