export class RoxyClient {
    constructor(port, token)  {
        this.port = port;
        this.token = token;
        this.host = '127.0.0.1';
        this.url = "http://" + this.host + ":" + this.port
        this.timeoutMs = Number(process.env.ROXYBROWSER_API_TIMEOUT_MS ?? process.env.ROXY_API_TIMEOUT_MS ?? 5000)
    }
    _build_headers() {
        return {"Content-Type": "application/json","token":this.token}
    }
    async _post(path,data) {
        const response = await this._fetchWithTimeout(`http://${this.host}:${this.port}${path}`, {
            method: 'post',
            body: JSON.stringify(data),
            headers: this._build_headers()
        });
        return response.json()
    }

    async _get(path,data) {
    
        let parmas = ""
        if (data) {
            for (var k in data) {
                let v = encodeURIComponent(data[k])
                k = encodeURIComponent(k)
                if (parmas == "") {
                    parmas = `${k}=${v}`
                } else {
                    parmas = `${parmas}&${k}=${v}`
                }
            }
        }
        let base_url = `http://${this.host}:${this.port}${path}`
        // console.log(base_url)
        const response = await this._fetchWithTimeout(parmas==""?base_url:`${base_url}?${parmas}`, {
            headers: this._build_headers()
        });
        return await response.json();
        
    }

    async _fetchWithTimeout(url, options = {}) {
        const timeoutMs = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0 ? this.timeoutMs : 5000
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        try {
            return await fetch(url, {
                ...options,
                signal: controller.signal
            })
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(`RoxyBrowser API request timed out after ${timeoutMs}ms: ${url}`)
            }
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    /*
    健康检查,用于检查API服务是否正常运行
    */
    health() {
        return this._get("/health")
    }
    
    /*
    获取工作空间项目列表,用于获取已拥有的空间和项目列表
    :param page_index,page_size 分页参数
    */
    workspace_project(self) {
        return this._get("/browser/workspace")
    }
    
    /*
    获取账号列表,用于获取已配置的平台账号
    :param workspaceId: 工作空间id, 必填，指定要获取哪个空间下的平台账号，通过workspace_project方法获取
    :param accountId: 账号库id, 选填
    :param page_index,page_size 分页参数
    */
    account(self,workspaceId,accountId = 0,page_index = 1,page_size = 15) {
        return self._get("/browser/account",{"workspaceId":workspaceId,"accountId":accountId,"page_index":page_index,"page_size":page_size})
    }
    /*
    获取标签列表,用于获取已配置的标签信息
    :param workspaceId: 工作空间id, 必填，指定要获取哪个空间下的标签，通过workspace_project方法获取
    */
    label(self,workspaceId) {
        return self._get("/browser/label",{"workspaceId":workspaceId})
    }
    /*
    获取窗口列表
    :param workspaceId: 工作空间id, 必填，指定要获取哪个空间下的窗口列表，通过workspace_project方法获取
    :param dirId: 窗口id, 选填；如果填了就只查询这个窗口的信息
    :param page_index,page_size 分页参数
    :res 返回值参考文档
    */
    browser_list(workspaceId,filters = "",page_index = 1,page_size = 15) {
        const data = typeof filters === "string"
            ? {"workspaceId":workspaceId,"sortNums":filters,"page_index":page_index,"page_size":page_size}
            : {"workspaceId":workspaceId,"page_index":page_index,"page_size":page_size,...filters};
        return this._get("/browser/list_v3",data)
    }
    
    /*
    获取浏览器窗口明细
    :param workspaceId: 工作空间id, 必填，指定要获取哪个空间下的窗口明细，通过workspace_project方法获取
    :param dirId: 窗口id, 必填，指定要获取的窗口
    :res 返回值参考文档
    */
    browser_detail(workspaceId, dirId) {
        return this._get("/browser/detail", {"workspaceId": workspaceId, "dirId": dirId})
    }

    /*
    创建窗口
    :param data: 创建窗口需要传的参数,参考文档说明，其中workspaceId为必传，通过workspace_project方法获取
    :res 返回值参考文档
    */
    browser_create(data = {}) {
        return this._post("/browser/create",data)
    }

    /*
    修改窗口
    :param data: 修改窗口需要传的参数,参考文档说明，其中workspaceId和dirId为必传，workspaceId通过workspace_project方法获取
    :res 返回值参考文档
    */
    browser_mdf(data = {}) {
        return this._post("/browser/mdf",data)
    }

    /*
    删除窗口
    :param workspaceId: 工作空间id, 必填，指定窗口所在的空间，通过workspace_project方法获取
    :param dirIds: 窗口id列表, 必填，指定要删除的浏览器窗口列表
    :res 返回值参考文档
    */
    browser_delete(workspaceId,dirid,isSoftDelete = false) {
        return this._post("/browser/delete",{"workspaceId":workspaceId,"dirIds":[dirid],"isSoftDelete":isSoftDelete})
    }

    /*
    打开窗口
    :param dirId: 需要打开的窗口ID，必填
    :param args: 指定浏览器启动参数，选填
    :res 返回值参考文档
    */
    browser_open(dirId,args=[],options={}) {
        return this._post("/browser/open",{"dirId":dirId,"args": args,...options})
    }

    /*
    关闭窗口
    :param dirId: 需要关闭的窗口ID，必填
    :res 返回值参考文档
    */
    browser_close(dirId) {
        return this._post("/browser/close",{"dirId":dirId})
    }

    /*
    清空窗口本地缓存
    :param dirIds: 窗口id列表, 必填，指定要清空缓存的窗口列表
    :res 返回值参考文档
    */
    browser_clear_local_cache(dirid) {
        return this._post("/browser/clear_local_cache",{"dirIds":[dirid]})
    }
    
    /*
    清空窗口服务器缓存
    :param workspaceId: 工作空间id, 必填，指定窗口所在的空间，通过workspace_project方法获取
    :param dirIds: 窗口id列表, 必填，指定要清空缓存的窗口列表
    :res 返回值参考文档
    */
    browser_clear_server_cache(workspaceId,dirid) {
        return this._post("/browser/clear_server_cache",{"workspaceId": workspaceId,"dirIds":[dirid]})
    }

    /*
    窗口随机指纹
    :param workspaceId: 工作空间id, 必填，指定窗口所在的空间，通过workspace_project方法获取
    :param dirId: 窗口id, 必填，指定需要随机指纹的窗口
    :res 返回值参考文档
    */
    browser_random_env(workspaceId,dirid) {
        return this._post("/browser/random_env",{"workspaceId": workspaceId,"dirId":dirid})
    }
    
    /*
    获取已打开的浏览器信息
    :param dirIds: 需要查询的窗口ID，选填
    :res 返回值参考文档
    */
    browser_connection_info(dirIds = "") {
        return this._get("/browser/connection_info", dirIds ? {"dirIds": dirIds} : undefined)
    }

}
