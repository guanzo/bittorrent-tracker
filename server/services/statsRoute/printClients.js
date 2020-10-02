const startHtml = '<ul>\n'
const endHtml = '</ul>'

function printClient (html, entry) {
  const [name, client] = entry

  const printClientHtml =
    (html, version) => (
      html + `<li><strong>${name}</strong> ${version} : ${client[version]}</li>\n`
    )

  const clientHtml =
            Object.values(client).reduce(printClientHtml, html)

  return clientHtml
};

function printClients (clients) {
  const contentHtml = Object.entries(clients).reduce(printClient, '')
  const html = startHtml + contentHtml + endHtml

  return html
}

module.exports = printClients
