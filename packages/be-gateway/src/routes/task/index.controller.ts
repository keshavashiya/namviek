import { mdMemberGetProject, mdTaskExport, mdTaskGetAll, mdTaskStatusQuery, mdTaskUpdate } from "@shared/models";
import { Get, Controller, Req, UseMiddleware } from "../../core";
import { AuthRequest } from "../../types";
import { BaseController } from "../../core";
import { authMiddleware, beProjectMemberMiddleware } from "../../middlewares";
import { getTodoCounter, updateTodoCounter } from "../../services/todo.counter";
import { CKEY, findNDelCaches, genKeyFromSource, getJSONCache, setJSONCache } from "../../lib/redis";
import { Task, TaskStatus } from "@prisma/client";
import { Post } from "../../core";

@Controller('/project/task')
@UseMiddleware([authMiddleware, beProjectMemberMiddleware])
export default class TaskController extends BaseController {
  @Get('/')
  async getTask() {
    const projectId = this.req.query.projectId as string
    const tasks = await mdTaskGetAll({ projectId, dueDate: [null, null] })
    console.log('get all task from project')

    return tasks
  }

  @Get('/counter')
  async countTasks() {
    const req = this.req as AuthRequest
    const { id: uid } = req.authen
    const { projectIds } = req.query as { projectIds: string[] }

    if (!projectIds.length) {
      return []
    }

    // get todo tasks by user

    const processes = []

    for (let i = 0; i < projectIds.length; i++) {
      const pid = projectIds[i]
      const todoCounter = await getTodoCounter([uid, pid])

      if (todoCounter) {
        processes.push(
          Promise.resolve({
            total: parseInt(todoCounter, 10),
            projectId: pid
          })
        )
        continue
      }

      processes.push(
        mdTaskGetAll({
          assigneeIds: [uid],
          projectId: pid,
          done: 'no',
          counter: true
        }).then(val => {
          return {
            total: val,
            projectId: pid
          }
        })
      )
    }

    // run all task query asynchronous
    const results = (await Promise.allSettled(
      processes
    )) as PromiseSettledResult<{ total: number; projectId: string }>[]

    // filter fulfilled results
    const lastResults = results.map(r => {
      if (r.status === 'fulfilled') {
        const { total, projectId } = r.value
        // update todo counter
        updateTodoCounter([uid, projectId], total)
        return {
          total,
          projectId
        }
      }
    })

    return lastResults

  }

  @Get('/query')
  async findTasks() {
    const req = this.req as AuthRequest

    const { counter, ...rest } = req.query

    let ableToCache = false
    const queryKeys = Object.keys(req.query)
    const projectId = req.query.projectId as string
    const key = [CKEY.TASK_QUERY, projectId, genKeyFromSource(req.query)]

    if (
      queryKeys.length === 2 &&
      queryKeys.includes('projectId') &&
      queryKeys.includes('dueDate')
    ) {
      ableToCache = true

      const cached = await getJSONCache(key)
      if (cached) {
        return {
          data: cached.data,
          total: cached.total
        }
        // return res.json({
        //   status: 200,
        //   data: cached.data,
        //   total: cached.total
        // })
      }
    }

    const tasks = await mdTaskGetAll(rest)
    if (counter) {
      const total = await mdTaskGetAll(req.query)
      if (ableToCache) {
        setJSONCache(key, { data: tasks, total })
      }

      return {
        data: tasks,
        total
      }
      // return res.json({ status: 200, data: tasks, total })

    }

    if (ableToCache) {
      setJSONCache(key, { data: tasks, total: 0 })
    }

    return tasks
    // res.json({ status: 200, data: tasks })

  }


  @Get('/export')
  async exportTaskList() {
    const req = this.req as AuthRequest
    // const query = req.body as ITaskQuery
    const { counter, ...rest } = req.query
    const { id: userId } = req.authen

    const sentProjectIds = rest.projectIds as string[]
    let projectIds = sentProjectIds
    if (projectIds && projectIds.length && projectIds.includes('ALL')) {
      const myProjectIds = await mdMemberGetProject(userId)
      projectIds = myProjectIds.map(p => p.projectId)
    }

    const promiseRequests = [
      mdTaskStatusQuery({
        projectIds
      }),
      mdTaskExport(rest)
    ]

    const result = await Promise.all(promiseRequests)
    const statuses = result[0] as TaskStatus[]
    const tasks = result[1] as Task[]

    const refactorStatuses = {}
    statuses.map((stt: TaskStatus) => {
      refactorStatuses[stt.id] = stt
    })

    const newTasks = []
    tasks.map(task => {
      const stt = refactorStatuses[task.taskStatusId]
      const taskStatusName = stt ? stt.name : null
      newTasks.push({
        ...task,
        ...{
          taskStatusName
        }
      })
    })

    if (counter) {
      const total = await mdTaskExport(req.query)
      return {
        data: newTasks,
        total
      }
      // return res.json({ status: 200, data: newTasks, total })
    }

    return newTasks
    // res.json({ status: 200, data: newTasks })
  }

  @Post('/make-cover')
  async setCoverToTask() {
    const req = this.req as AuthRequest
    const { taskId, url, projectId } = req.body as {
      taskId: string
      projectId: string
      url: string
    }
    const { id: uid } = req.authen

    const result = await mdTaskUpdate({
      id: taskId,
      cover: url,
      updatedAt: new Date(),
      updatedBy: uid
    })

    const key = [CKEY.TASK_QUERY, projectId]
    await findNDelCaches(key)

    return result
    // res.json({ data: result })
  }
}
