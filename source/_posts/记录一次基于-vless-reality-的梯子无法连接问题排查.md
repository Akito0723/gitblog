---
title: 记录一次基于 VLESS + REALITY 的梯子无法连接问题排查
date: 2026-06-25 17:49:00
categories:
  - 网络排障
tags:
  - VLESS
  - REALITY
  - Xray
  - TLS
  - OCSP
description: 记录一次由 www.microsoft.com 的 OCSP stapling 响应变大触发 REALITY 8192 字节边界，导致代理连接间歇性失败的排查过程。
---

## 背景

一次基于 Xray VLESS + REALITY 的代理连接出现间歇性失败。客户端侧表现为连接目标站点时偶发 `EOF`、握手失败或连接被重置。

初看网络端口可达，Xray 服务也在运行，因此问题不像是单纯的端口、防火墙或进程崩溃。进一步排查后，问题集中到 Xray 入站配置中 REALITY 的伪装目标站设置：

```json
{
  "inbounds": [
    {
      "streamSettings": {
        "security": "reality",
        "realitySettings": {
          "dest": "www.microsoft.com:443",
          "serverNames": [
            "www.microsoft.com"
          ]
        }
      }
    }
  ]
}
```

也就是说，异常连接最终都需要由 REALITY 去探测并复用 `www.microsoft.com:443` 这个目标站的 TLS 握手特征。该域名背后由 Akamai CDN 承载。最终确认：问题不是 VLESS 用户配置错误，不是 GFW 屏蔽，也不是证书链本体错误，而是 `www.microsoft.com` 在 Akamai 边缘节点上返回了不同的 TLS `Certificate` 消息，其中部分响应超过了 Xray REALITY 当前处理路径中的 8192 字节边界，导致握手失败。TLS 1.3 的 `Certificate` 消息结构允许在每个 `CertificateEntry` 后携带扩展字段，OCSP stapling 正是通过这类扩展携带响应数据，这也是本次证书链本体不变但完整 `Certificate` 消息变大的原因之一 [1][2]。

## 现象

连接表现为不稳定：同样配置下，有时可以成功，有时失败。

在 Xray REALITY 打开 debug 后，可以看到失败连接在解析目标站 TLS 握手时中断：

```text
REALITY remoteAddr: 127.0.0.1:59360
REALITY remoteAddr: 127.0.0.1:59360    len(s2cSaved): 5544    Server Hello: 127
REALITY remoteAddr: 127.0.0.1:59360    len(s2cSaved): 5417    Change Cipher Spec: 6
REALITY remoteAddr: 127.0.0.1:59360    len(s2cSaved): 5411    Encrypted Extensions: 51
REALITY remoteAddr: 127.0.0.1:59360    len(s2cSaved): 5360    Certificate: 8273
REALITY remoteAddr: 127.0.0.1:59360    hs.c.isHandshakeComplete.Load(): false
REALITY: processed invalid connection ... handshake did not complete successfully
```

关键点是：

```text
Certificate: 8273
```

这个值超过了 REALITY 相关处理逻辑中的 8192 字节边界。超过后，后续 `Certificate Verify` 和 `Finished` 无法完整处理，REALITY 握手失败。

## 成功与失败的对照证据

同一台机器、同一个 SNI、同一个 REALITY `fingerprint=chrome` 路径下，观察到了两类 TLS `Certificate` 消息。

失败时：

```text
Certificate: 8273
hs.c.isHandshakeComplete.Load(): false
REALITY: processed invalid connection ... handshake did not complete successfully
```

成功时：

```text
Certificate: 7787
Certificate Verify: 286
Finished: 74
hs.c.isHandshakeComplete.Load(): true
```

这说明问题不是配置随机失效，而是同样连接条件下，目标站返回的 TLS `Certificate` 消息大小存在波动。

## 进一步定位：变化来自 OCSP Stapling

解析 TLS 1.3 `Certificate` 消息后，确认变化点不是三张证书本体，而是叶子证书对应的 `CertificateEntry.extensions`。

其中关键扩展是：

```text
ext_type 5
```

TLS 扩展类型 `5` 对应 `status_request`，也就是 OCSP stapling。根据 TLS 扩展规范，`status_request` 可用于请求服务端在握手中返回 OCSP response；在 TLS 1.3 中，该响应位于证书条目的扩展区域 [1][2]。

当没有 OCSP stapling 时，`Certificate` 消息较小：

```text
Certificate message length: 5902
cert_list_len: 5894

entry 0 cert_len 2478 ext_total 0
entry 1 cert_len 1980 ext_total 0
entry 2 cert_len 1421 ext_total 0
```

当请求 OCSP stapling 后，叶子证书条目出现额外扩展：

```text
Certificate message length: 8251
cert_list_len: 8243

entry 0 cert_len 2478 ext_total 2349
  ext_type 5 ext_len 2345

entry 1 cert_len 1980 ext_total 0
entry 2 cert_len 1421 ext_total 0
```

也就是说，`www.microsoft.com` 的证书链本体没有异常，真正把 `Certificate` 消息推大的，是 OCSP stapling 扩展。

## 两套不同的 OCSP Staple

继续解析 OCSP response 后，发现 Akamai 边缘返回了两套不同的 OCSP staple。

较小的一套：

```text
OCSP DER len: 1855
Certificate message: 7765
Responder Id: 66CD05020FBA08BB7C50D11567E0E0A420031580
Produced At: Jun 18 14:07:11 2026 GMT
This Update: Jun 18 10:13:08 2026 GMT
Next Update: Jun 26 10:33:08 2026 GMT
OCSP response signature: sha256WithRSAEncryption
Responder cert:
  CN=TLS-G2-RSA-04 OCSP Cert
Responder public key:
  RSA 2048 bit
```

这套响应下，完整 TLS `Certificate` 消息约为 `7765` 字节，低于 8192，REALITY 可以成功完成握手。

较大的一套：

```text
OCSP DER len: 2341
Certificate message: 8251
Responder Id: 18F1FD78E3F67E8B1F99D121102179D43E2497A9
Produced At: Jun 23 03:59:39 2026 GMT
This Update: Jun 23 03:59:39 2026 GMT
Next Update: Jun 27 03:59:39 2026 GMT
OCSP response signature: sha384WithRSAEncryption
Responder cert:
  CN=Microsoft TLS G2 RSA CA OCSP 04 External OCSP Responder 2026-06-
Responder public key:
  RSA 4096 bit
```

这套响应下，完整 TLS `Certificate` 消息约为 `8251` 字节，超过 8192，REALITY 握手失败。

两套 OCSP response 的直接大小差异：

```text
2341 - 1855 = 486 bytes
```

差异主要来自：

```text
1. 大响应使用 4096-bit OCSP responder key，签名体积更大。
2. 大响应内嵌的 External OCSP Responder 证书本身更大。
3. 大响应使用 sha384WithRSAEncryption，小响应使用 sha256WithRSAEncryption。
4. 两份响应的 Produced At / This Update / Next Update 不同，说明它们不是同一份 OCSP response。
```

从时间和 responder 命名看，两套 OCSP response 还体现出一次明显的 responder 切换：

```text
旧 responder:
  CN=TLS-G2-RSA-04 OCSP Cert
  RSA 2048
  OCSP response signature: sha256WithRSAEncryption
  Produced At: Jun 18 14:07:11 2026 GMT
  Certificate message: 7765

新 responder:
  CN=Microsoft TLS G2 RSA CA OCSP 04 External OCSP Responder 2026-06-
  RSA 4096
  OCSP response signature: sha384WithRSAEncryption
  Produced At: Jun 23 03:59:39 2026 GMT
  Certificate message: 8251
```

基于这个对照，可以合理推测：`www.microsoft.com` 背后的 Akamai 边缘节点在 2026-06 之后开始为该证书使用新的 External OCSP responder。新的 External OCSP responder 使用 4096-bit RSA 和更大的 responder 证书，使 OCSP stapling 体积增加，最终把 TLS `Certificate` 消息推到 8192 字节以上。

## 固定 Akamai 边缘 IP 后仍然复现

为了排除“只是 DNS 解析到了不同 IP”的可能，测试时固定了同一个 Akamai 边缘 IPv4 地址。

固定连接条件：

```text
SNI: www.microsoft.com
固定 Akamai 边缘 IP: 23.35.101.225:443
TLS: 1.3
请求: OCSP stapling
```

固定同一个 IP 后，仍然观察到两套响应。

较大响应多次出现：

```text
cert_msg_len=8251
responder=18F1FD78E3F67E8B...
Produced At: Jun 23 03:59:39 2026 GMT
Signature: sha384WithRSAEncryption
Responder cert:
  Microsoft TLS G2 RSA CA OCSP 04 External OCSP Responder...
```

较小响应也会出现：

```text
cert_msg_len=7765
responder=66CD05020FBA08BB...
Produced At: Jun 18 14:07:11 2026 GMT
Signature: sha256WithRSAEncryption
Responder cert:
  TLS-G2-RSA-04 OCSP Cert
```

这说明问题不是 DNS 在不同公网 IP 之间切换。更合理的解释是：

```text
同一个 Akamai 边缘 IP 后面不是单一 TLS 实例；
该 IP 背后可能有多个 Akamai TLS terminator / worker / cache shard；
不同实例持有的 OCSP staple cache 不一致；
因此同一个 SNI、同一个边缘 IP，也可能返回不同的 OCSP staple。
```

## 根因判断

本次问题的根因可以概括为：

```text
www.microsoft.com 在 Akamai 边缘侧存在两套 OCSP staple。
旧响应使用 2048-bit responder，TLS Certificate message 约 7765 字节，REALITY 成功。
新响应使用 4096-bit External OCSP Responder，TLS Certificate message 约 8251/8273 字节，超过 REALITY 8192 边界，REALITY 失败。
```

其中“External OCSP Responder 2026-06”是本次问题最关键的变化点。它不是让证书链本体失效，而是让 OCSP stapling 扩展变大；在 REALITY 需要处理完整 TLS `Certificate` 消息时，这个增量触发了 8192 字节边界。REALITY 源码中存在 `size = 8192` 的固定缓冲边界，相关处理逻辑会解析服务端返回的 TLS 握手消息类型，包括 `Server Hello`、`Encrypted Extensions`、`Certificate`、`Certificate Verify` 和 `Finished` [3]。

源码中的关键定义大致如下：

```go
var (
    size  = 8192
    empty = make([]byte, size)
    types = [7]string{
        "Server Hello",
        "Change Cipher Spec",
        "Encrypted Extensions",
        "Certificate",
        "Certificate Verify",
        "Finished",
        "New Session Ticket",
    }
)
```

后续服务端到客户端方向的探测缓存和读取缓冲也使用这个大小：

```go
s2cSaved := make([]byte, 0, size)
buf := make([]byte, size)
```

这类问题具有明显的不稳定特征：

```text
同一配置不一定必现失败；
同一 SNI 不一定每次失败；
同一 Akamai 边缘 IP 也可能成功或失败；
命中较小 OCSP staple 时成功；
命中较大 OCSP staple 时失败。
```

## 处理方式

最终处理方式是更换 REALITY 的 `serverName` / `dest`，避免继续使用 `www.microsoft.com` 作为伪装目标。

选择 REALITY 目标站时，应尽量避开以下类型：

```text
1. 大型 CDN 后面频繁轮换 TLS/OCSP 策略的域名。
2. TLS Certificate message 接近 8192 字节边界的域名。
3. OCSP stapling response 体积较大或不稳定的域名。
4. 同一边缘 IP 背后可能返回多套 OCSP staple 的域名。
```

更换为更稳定的目标站后，连接稳定性恢复。

## 结论

这次问题不是代理链路本身异常，而是 REALITY 依赖目标站 TLS 行为进行伪装时，目标站返回内容触发了边界条件。

`www.microsoft.com` 背后的 Akamai 边缘 IP 会返回不同 TLS 实例或不同 cache shard 持有的 OCSP staple：

```text
小 OCSP staple -> Certificate message 约 7787 -> 低于 8192 -> 成功
大 OCSP staple -> Certificate message 约 8273 -> 超过 8192 -> 失败
```

因此，在 REALITY 场景下，`www.microsoft.com` 不适合作为稳定的 `serverName` / `dest`。即使域名本身正常、证书链有效，也可能因为 OCSP stapling 导致 TLS `Certificate` 消息超过 REALITY 的处理边界，从而产生间歇性连接失败。

## 参考资料

[1] RFC 8446, The Transport Layer Security (TLS) Protocol Version 1.3. 参考重点：TLS 1.3 的 `Certificate` 消息结构，以及 `CertificateEntry` 中的 `extensions` 字段。  
https://www.rfc-editor.org/rfc/rfc8446.html

[2] RFC 6066, Transport Layer Security (TLS) Extensions. 参考重点：`status_request` 扩展及其用于携带 OCSP stapling 响应的机制。  
https://www.rfc-editor.org/rfc/rfc6066.html

[3] XTLS REALITY 源码 `tls.go`。参考重点：REALITY 底层 TLS 握手处理中的 `size = 8192`，以及对 `Certificate` 等握手消息的解析逻辑。  
https://github.com/XTLS/REALITY/blob/main/tls.go

[4] 本次实测证据，采集环境为同一台服务器对 `www.microsoft.com` 发起 TLS 1.3 / OCSP stapling / REALITY debug 测试。参考重点：同一 Akamai 边缘 IP `23.35.101.225:443` 下，分别出现 `Certificate message 7765` 和 `Certificate message 8251/8273`，对应两套不同 OCSP responder。该证据来自本次排查命令输出，不是公开网页资料。
